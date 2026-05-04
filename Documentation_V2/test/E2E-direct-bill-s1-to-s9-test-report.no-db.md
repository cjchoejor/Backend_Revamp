# E2E direct-bill flow report (S1 → S9)

- **Ran at**: 2026-04-27T07:12:42.726Z
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `7a02c505-9743-4106-95b3-8fa48234310b`
- **Inquiry ID**: `2b82882b-1694-4767-bff0-ee54dff9aeaa`
- **GuestProfile ID (seeded)**: `06ccf167-0619-4686-b1bc-ad5cb463dcb9`

## Steps

### S1 availability search

- **Request**: `POST` `/availability/search` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
    "checkInDate": "2026-04-27T00:00:00.000Z",
    "checkOutDate": "2026-04-28T00:00:00.000Z",
    "guestCount": 1,
    "useType": "LEISURE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "configurationId": "c1323e7f-e7b3-4197-acd6-4724bd5e86c7",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "queriedAt": "2026-04-27T07:12:42.945Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "af1318b9-c409-4434-bb01-aee51cacaf6f",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "b73fb795-eb9c-4747-82b0-bf2a93ecedb0",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "b73fb795-eb9c-4747-82b0-bf2a93ecedb0"
      },
      {
        "inventoryId": "442690e0-58bc-4131-8fed-3faa41eca846",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "442690e0-58bc-4131-8fed-3faa41eca846"
      },
      {
        "inventoryId": "9053a13f-e423-4e36-9839-315174e6b51e",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "9053a13f-e423-4e36-9839-315174e6b51e"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "d8d4ebb5-5203-4fdd-a8b1-f535ca45323b",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "d8d4ebb5-5203-4fdd-a8b1-f535ca45323b"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-27T07:12:42.943Z",
    "isRevalidationRequired": false
  }
}
```

### S1 select availability option

- **Request**: `PATCH` `/availability/configurations/c1323e7f-e7b3-4197-acd6-4724bd5e86c7/select` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "c1323e7f-e7b3-4197-acd6-4724bd5e86c7",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
    "useType": "LEISURE",
    "guestCount": 1,
    "checkInDate": "2026-04-27T00:00:00.000Z",
    "checkOutDate": "2026-04-28T00:00:00.000Z"
  },
  "resultSet": {
    "availableRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "401",
        "inventoryId": "af1318b9-c409-4434-bb01-aee51cacaf6f"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "d8d4ebb5-5203-4fdd-a8b1-f535ca45323b",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-27T07:12:42.943Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "b73fb795-eb9c-4747-82b0-bf2a93ecedb0",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "442690e0-58bc-4131-8fed-3faa41eca846",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "9053a13f-e423-4e36-9839-315174e6b51e",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T07:12:42.945Z",
  "createdBy": "e2e-fd-2"
}
```

### S1->S2 progress-stage

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/progress-stage` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "targetStage": "S2",
    "version": 1
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7a02c505-9743-4106-95b3-8fa48234310b",
  "inquiryId": "2b82882b-1694-4767-bff0-ee54dff9aeaa",
  "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T07:12:42.892Z",
  "updatedAt": "2026-04-27T07:12:43.034Z",
  "createdBy": "e2e-fd-2",
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
}
```

### S2 create quotation

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/quotations` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "nightlyRate": 100,
    "currency": "BTN",
    "notes": "e2e quotation"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "c455ef25-4cf2-49ec-8c40-de38aeebf41d",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "segmentId": "db49f0ac-933c-4c2c-b588-52fded95f9fb",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "0c7b0298-fb74-4e72-93d3-6e953cae495e",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": null,
  "sentAt": null,
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T07:12:43.066Z",
  "createdBy": "e2e-fd-2"
}
```

### S2 send quotation

- **Request**: `POST` `/quotations/c455ef25-4cf2-49ec-8c40-de38aeebf41d/send` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "c455ef25-4cf2-49ec-8c40-de38aeebf41d",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "segmentId": "db49f0ac-933c-4c2c-b588-52fded95f9fb",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "0c7b0298-fb74-4e72-93d3-6e953cae495e",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T07:12:43.093Z",
  "sentAt": "2026-04-27T07:12:43.093Z",
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T07:12:43.066Z",
  "createdBy": "e2e-fd-2"
}
```

### S2 accept quotation

- **Request**: `POST` `/quotations/c455ef25-4cf2-49ec-8c40-de38aeebf41d/accept` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "c455ef25-4cf2-49ec-8c40-de38aeebf41d",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "segmentId": "db49f0ac-933c-4c2c-b588-52fded95f9fb",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "ACCEPTED",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "0c7b0298-fb74-4e72-93d3-6e953cae495e",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T07:12:43.093Z",
  "sentAt": "2026-04-27T07:12:43.093Z",
  "sentTo": null,
  "communicationRecordId": "0e0da067-b267-48e3-b929-8c548a5e2a23",
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": "2026-04-27T07:12:43.236Z",
  "acceptedBy": "e2e-fd-2",
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T07:12:43.066Z",
  "createdBy": "e2e-fd-2"
}
```

### S2->S3 progress-stage

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/progress-stage` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "targetStage": "S3",
    "version": 2
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7a02c505-9743-4106-95b3-8fa48234310b",
  "inquiryId": "2b82882b-1694-4767-bff0-ee54dff9aeaa",
  "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S3",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T07:12:42.892Z",
  "updatedAt": "2026-04-27T07:12:43.308Z",
  "createdBy": "e2e-fd-2",
  "version": 3,
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
}
```

### S3 ensure provisional folio + billing model

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/folio/provisional` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "billingModel": "DIRECT_BILL"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "71c80d12-140c-4c72-85a0-c6dd1b752885",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "state": "PROVISIONAL",
  "billingModel": "DIRECT_BILL",
  "createdAt": "2026-04-27T07:12:43.337Z",
  "createdBy": "e2e-fd-2",
  "convertedToLiveAt": null,
  "convertedBy": null,
  "closedAt": null,
  "closedBy": null,
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": false,
  "invoices": [
    {
      "id": "75d929f7-eea9-4d92-b882-86609451ddcc",
      "folioId": "71c80d12-140c-4c72-85a0-c6dd1b752885",
      "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T07:12:43.340Z",
      "issuedBy": "e2e-fd-2",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T07:12:43.342Z"
    }
  ]
}
```

### S3 credit extension approval (DIRECT_BILL path)

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/credit-extension` (actor `L2` / `e2e-fom-2`)

```json
{
  "body": {
    "ceilingAmount": 999999,
    "reason": "Direct bill arrangement"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "090b2d25-59ec-40c6-afc2-cb729eba2d44",
  "folioId": "71c80d12-140c-4c72-85a0-c6dd1b752885",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "ceilingAmount": "999999",
  "currency": "BTN",
  "approvedBy": "e2e-fom-2",
  "approvedAt": "2026-04-27T07:12:43.380Z",
  "reason": "Direct bill arrangement",
  "createdAt": "2026-04-27T07:12:43.382Z"
}
```

### S3 reconcile advance payment (DIRECT_BILL no-payment)

- **Request**: `POST` `/folios/71c80d12-140c-4c72-85a0-c6dd1b752885/advance-payment/reconcile` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
    "note": "DIRECT_BILL reconciliation"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "71c80d12-140c-4c72-85a0-c6dd1b752885",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "state": "PROVISIONAL",
  "billingModel": "DIRECT_BILL",
  "createdAt": "2026-04-27T07:12:43.337Z",
  "createdBy": "e2e-fd-2",
  "convertedToLiveAt": null,
  "convertedBy": null,
  "closedAt": null,
  "closedBy": null,
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": true
}
```

### S3 cancellation disclosure

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/disclosures/cancellation` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "noShowTreatmentStatement": "Standard no-show policy",
    "disclosedTerms": {
      "windowHours": 24
    }
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "efb33e2a-3fcd-4a19-b60d-41a0253f7195",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "segmentId": "db49f0ac-933c-4c2c-b588-52fded95f9fb",
  "noShowTreatmentStatement": "Standard no-show policy",
  "disclosedTerms": {
    "windowHours": 24
  },
  "disclosedAt": "2026-04-27T07:12:43.443Z",
  "disclosedBy": "e2e-fd-2"
}
```

### S3 committed hold

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/holds/committed` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f",
    "commercialJustification": "Direct bill scenario hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "6549e067-9247-47e8-bdc2-30da35921ea2",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "segmentId": "db49f0ac-933c-4c2c-b588-52fded95f9fb",
  "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f",
  "spaceId": null,
  "roomTypeId": "0c7b0298-fb74-4e72-93d3-6e953cae495e",
  "state": "PLACED",
  "placedAt": "2026-04-27T07:12:43.485Z",
  "placedBy": "e2e-fd-2",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "Direct bill scenario hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-27T08:12:43.485Z"
}
```

### S3->S4 confirm reservation

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/confirm` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "version": 3
  }
}
```

- **Response**: HTTP 200

```json
{
  "reservation": {
    "id": "dae649d3-2cfc-44ad-8940-b1360fa3e840",
    "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
    "segmentId": "db49f0ac-933c-4c2c-b588-52fded95f9fb",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {
      "windowHours": 24
    },
    "frozenBillingModel": "DIRECT_BILL",
    "frozenCheckInDate": "2026-04-27T00:00:00.000Z",
    "frozenCheckOutDate": "2026-04-28T00:00:00.000Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": "999999",
    "confirmedAt": "2026-04-27T07:12:43.543Z",
    "confirmedBy": "e2e-fd-2",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-27T07:12:43.544Z"
  },
  "entry": {
    "id": "7a02c505-9743-4106-95b3-8fa48234310b",
    "inquiryId": "2b82882b-1694-4767-bff0-ee54dff9aeaa",
    "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-04-27T00:00:00.000Z",
    "checkOutDate": "2026-04-28T00:00:00.000Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-04-27T07:12:42.892Z",
    "updatedAt": "2026-04-27T07:12:43.556Z",
    "createdBy": "e2e-fd-2",
    "version": 4,
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
  }
}
```

### W4 pre-arrival activation (manual trigger)

- **Request**: `WORKER` `PRE_ARRIVAL_COUNTDOWN_W4` (actor `L1` / `SYSTEM`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
{
  "skipped": false,
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b"
}
```

### S5 complete pre-arrival task 5b2df2ae-41e5-4e19-847c-ddc32a332063

- **Request**: `PATCH` `/pre-arrival-tasks/5b2df2ae-41e5-4e19-847c-ddc32a332063` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "5b2df2ae-41e5-4e19-847c-ddc32a332063",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "PAYMENT_RECONCILIATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:53.809Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 7441f6cb-82bd-441f-9527-db4590cfff21

- **Request**: `PATCH` `/pre-arrival-tasks/7441f6cb-82bd-441f-9527-db4590cfff21` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7441f6cb-82bd-441f-9527-db4590cfff21",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "CREDIT_CEILING_CHECK",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:53.836Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task cd420f53-e605-4ce0-a543-09e44cb0b20f

- **Request**: `PATCH` `/pre-arrival-tasks/cd420f53-e605-4ce0-a543-09e44cb0b20f` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "cd420f53-e605-4ce0-a543-09e44cb0b20f",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "NIGHT_AUDIT_TIMER_REGISTRATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:53.863Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 214a1aee-97a0-43c6-a8b0-a71ef0671007

- **Request**: `PATCH` `/pre-arrival-tasks/214a1aee-97a0-43c6-a8b0-a71ef0671007` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "214a1aee-97a0-43c6-a8b0-a71ef0671007",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "BED_CONFIGURATION_CHANGE",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:53.887Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 1b6038d8-a35c-4a8c-b19d-75aca6d04372

- **Request**: `PATCH` `/pre-arrival-tasks/1b6038d8-a35c-4a8c-b19d-75aca6d04372` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "1b6038d8-a35c-4a8c-b19d-75aca6d04372",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "PRE_ARRIVAL_COMMUNICATION",
  "category": "COMMUNICATION",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:53.917Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task eff16911-c347-4246-8b66-d1674ad279e7

- **Request**: `PATCH` `/pre-arrival-tasks/eff16911-c347-4246-8b66-d1674ad279e7` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "eff16911-c347-4246-8b66-d1674ad279e7",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "SPECIAL_REQUEST_FULFILMENT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:53.941Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task dedb94a4-d222-4ac7-a376-6106124f2246

- **Request**: `PATCH` `/pre-arrival-tasks/dedb94a4-d222-4ac7-a376-6106124f2246` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "dedb94a4-d222-4ac7-a376-6106124f2246",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "LATE_ARRIVAL_MEAL_COORDINATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:53.967Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task d7eb1b97-9c02-4511-a650-1f5900f1c99f

- **Request**: `PATCH` `/pre-arrival-tasks/d7eb1b97-9c02-4511-a650-1f5900f1c99f` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "d7eb1b97-9c02-4511-a650-1f5900f1c99f",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "SITE_VISIT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:53.993Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task d42eef3d-4751-400c-a706-6901e3fe24c1

- **Request**: `PATCH` `/pre-arrival-tasks/d42eef3d-4751-400c-a706-6901e3fe24c1` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "d42eef3d-4751-400c-a706-6901e3fe24c1",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "taskType": "UNIT_READINESS_VERIFICATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T07:12:54.020Z",
  "completedBy": "e2e-fd-2",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T07:12:53.743Z",
  "createdBy": "SYSTEM"
}
```

### S5 room assignment

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/room-assignments` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f",
    "notes": "e2e assign"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "b30c5e25-980d-44b5-a2ae-1b3f4ea8715c",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f",
  "assignedAt": "2026-04-27T07:12:54.055Z",
  "assignedBy": "e2e-fd-2",
  "deficientAtAssignment": false,
  "deficientConditionRecordId": null,
  "acknowledgementActorId": null,
  "acknowledgementAt": null,
  "notes": "e2e assign",
  "createdAt": "2026-04-27T07:12:54.055Z"
}
```

### S5 accept H1

- **Request**: `POST` `/handoffs/1d805176-e1f5-4579-8e87-7880b9876a25/accept` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "checklistCompletion": {
      "VOUCHER_VERIFIED": true,
      "PAYMENT_STATUS_REVIEWED": true
    }
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "1d805176-e1f5-4579-8e87-7880b9876a25",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "handoffType": "H1",
  "state": "ACCEPTED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-2",
  "toRole": "FRONT_DESK",
  "toActorId": null,
  "checklistContent": [
    {
      "code": "VOUCHER_VERIFIED",
      "mandatory": true,
      "description": "Confirmation voucher on file"
    },
    {
      "code": "PAYMENT_STATUS_REVIEWED",
      "mandatory": true,
      "description": "Advance payment status reviewed"
    },
    {
      "code": "SPECIAL_REQUESTS_NOTED",
      "mandatory": false,
      "description": "Special requests noted"
    }
  ],
  "deficientConditionStatus": null,
  "fulfilmentEvidence": null,
  "assignedAt": null,
  "acceptedAt": "2026-04-27T07:12:54.096Z",
  "acceptedBy": "e2e-fd-2",
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
  "createdAt": "2026-04-27T07:12:43.554Z",
  "createdBy": "e2e-fd-2",
  "stageContext": "S4"
}
```

### S5 fulfil H1

- **Request**: `POST` `/handoffs/1d805176-e1f5-4579-8e87-7880b9876a25/fulfil` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "fulfilmentEvidence": {
      "roomAssignmentId": "b30c5e25-980d-44b5-a2ae-1b3f4ea8715c",
      "readinessConfirmed": true,
      "paymentStatusConfirmed": true,
      "ceilingProximityAddressed": true
    }
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "1d805176-e1f5-4579-8e87-7880b9876a25",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "handoffType": "H1",
  "state": "FULFILLED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-2",
  "toRole": "FRONT_DESK",
  "toActorId": null,
  "checklistContent": [
    {
      "code": "VOUCHER_VERIFIED",
      "mandatory": true,
      "description": "Confirmation voucher on file"
    },
    {
      "code": "PAYMENT_STATUS_REVIEWED",
      "mandatory": true,
      "description": "Advance payment status reviewed"
    },
    {
      "code": "SPECIAL_REQUESTS_NOTED",
      "mandatory": false,
      "description": "Special requests noted"
    }
  ],
  "deficientConditionStatus": null,
  "fulfilmentEvidence": {
    "roomAssignmentId": "b30c5e25-980d-44b5-a2ae-1b3f4ea8715c",
    "readinessConfirmed": true,
    "paymentStatusConfirmed": true,
    "ceilingProximityAddressed": true
  },
  "assignedAt": null,
  "acceptedAt": "2026-04-27T07:12:54.096Z",
  "acceptedBy": "e2e-fd-2",
  "fulfilledAt": "2026-04-27T07:12:54.124Z",
  "fulfilledBy": "e2e-fd-2",
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
  "createdAt": "2026-04-27T07:12:43.554Z",
  "createdBy": "e2e-fd-2",
  "stageContext": "S4"
}
```

### S5->S6 progress-stage (guest present)

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/progress-stage` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "targetStage": "S6",
    "version": 5,
    "guestPhysicallyPresent": true
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7a02c505-9743-4106-95b3-8fa48234310b",
  "inquiryId": "2b82882b-1694-4767-bff0-ee54dff9aeaa",
  "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S6",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T07:12:42.892Z",
  "updatedAt": "2026-04-27T07:12:54.167Z",
  "createdBy": "e2e-fd-2",
  "version": 6,
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
}
```

### S6 create H2

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/handoffs/h2` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "roomNumber": "401",
    "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
    "deficientConditionStatus": null
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "b66f52b8-cc47-45fd-8be0-85e37cec2f8a",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "handoffType": "H2",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-2",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "roomNumber": "401",
    "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
    "deficientConditionStatus": null
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
  "slaDeadlineAt": "2026-04-27T08:12:54.209Z",
  "isAutoFulfilled": false,
  "createdAt": "2026-04-27T07:12:54.211Z",
  "createdBy": "e2e-fd-2",
  "stageContext": "S6"
}
```

### S6 verify guest identity

- **Request**: `POST` `/guest-profiles/06ccf167-0619-4686-b1bc-ad5cb463dcb9/verify-identity` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
    "verificationPath": "FIRST_TIME",
    "documentType": "PASSPORT",
    "documentNumber": "E2E-1777273974232",
    "issuingCountry": "BT"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
  "firstName": "Tashi",
  "lastName": "Dorji",
  "email": "tashi.dorji@example.com",
  "phone": null,
  "nationality": null,
  "vipTier": null,
  "clientTier": "STANDARD",
  "preferences": null,
  "behaviouralFlags": null,
  "observationQueue": null,
  "stayHistorySummary": null,
  "isActive": true,
  "identityVerifiedAt": "2026-04-27T07:12:54.247Z",
  "identityVerifiedBy": "e2e-fd-2",
  "identityVerificationPath": "FIRST_TIME",
  "createdAt": "2026-04-27T07:12:41.314Z",
  "updatedAt": "2026-04-27T07:12:54.247Z",
  "createdBy": "actor-seed-system"
}
```

### S6->S7 progress-stage (complete check-in)

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/progress-stage` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "targetStage": "S7",
    "version": 6,
    "transitionData": {
      "keyCount": 2,
      "registrationConfirmed": true
    }
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7a02c505-9743-4106-95b3-8fa48234310b",
  "inquiryId": "2b82882b-1694-4767-bff0-ee54dff9aeaa",
  "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S7",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T07:12:42.892Z",
  "updatedAt": "2026-04-27T07:12:54.292Z",
  "createdBy": "e2e-fd-2",
  "version": 7,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T07:12:54.292Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-2",
  "registrationCompletedAt": "2026-04-27T07:12:54.292Z",
  "registrationCompletedBy": "e2e-fd-2",
  "folio": {
    "id": "71c80d12-140c-4c72-85a0-c6dd1b752885",
    "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
    "state": "LIVE",
    "billingModel": "DIRECT_BILL",
    "createdAt": "2026-04-27T07:12:43.337Z",
    "createdBy": "e2e-fd-2",
    "convertedToLiveAt": "2026-04-27T07:12:54.302Z",
    "convertedBy": "e2e-fd-2",
    "closedAt": null,
    "closedBy": null,
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "0",
    "advancePaymentReconciliationComplete": true
  },
  "guestProfile": {
    "id": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
    "firstName": "Tashi",
    "lastName": "Dorji",
    "email": "tashi.dorji@example.com",
    "phone": null,
    "nationality": null,
    "vipTier": null,
    "clientTier": "STANDARD",
    "preferences": null,
    "behaviouralFlags": null,
    "observationQueue": null,
    "stayHistorySummary": null,
    "isActive": true,
    "identityVerifiedAt": "2026-04-27T07:12:54.247Z",
    "identityVerifiedBy": "e2e-fd-2",
    "identityVerificationPath": "FIRST_TIME",
    "createdAt": "2026-04-27T07:12:41.314Z",
    "updatedAt": "2026-04-27T07:12:54.247Z",
    "createdBy": "actor-seed-system"
  },
  "handoffs": [
    {
      "id": "5272d2d3-0080-4f62-8190-041ee7806414",
      "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
      "handoffType": "H3",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-2",
      "toRole": "F_AND_B",
      "toActorId": null,
      "checklistContent": {
        "mealPlan": "per reservation inclusions",
        "guestCount": 1,
        "roomNumber": "401",
        "stayDuration": {
          "checkInDate": "2026-04-27T00:00:00.000Z",
          "checkOutDate": "2026-04-28T00:00:00.000Z"
        },
        "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
        "packageInclusions": [],
        "cuisinePreferences": null,
        "dietaryRequirements": null
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
      "slaDeadlineAt": "2026-04-27T08:12:54.292Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T07:12:54.300Z",
      "createdBy": "e2e-fd-2",
      "stageContext": "S6"
    },
    {
      "id": "b66f52b8-cc47-45fd-8be0-85e37cec2f8a",
      "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
      "handoffType": "H2",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-2",
      "toRole": "HOUSEKEEPING",
      "toActorId": null,
      "checklistContent": {
        "roomNumber": "401",
        "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
        "deficientConditionStatus": null
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
      "slaDeadlineAt": "2026-04-27T08:12:54.209Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T07:12:54.211Z",
      "createdBy": "e2e-fd-2",
      "stageContext": "S6"
    },
    {
      "id": "1d805176-e1f5-4579-8e87-7880b9876a25",
      "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
      "handoffType": "H1",
      "state": "CLOSED",
      "fromRole": "RESERVATIONS",
      "fromActorId": "e2e-fd-2",
      "toRole": "FRONT_DESK",
      "toActorId": null,
      "checklistContent": [
        {
          "code": "VOUCHER_VERIFIED",
          "mandatory": true,
          "description": "Confirmation voucher on file"
        },
        {
          "code": "PAYMENT_STATUS_REVIEWED",
          "mandatory": true,
          "description": "Advance payment status reviewed"
        },
        {
          "code": "SPECIAL_REQUESTS_NOTED",
          "mandatory": false,
          "description": "Special requests noted"
        }
      ],
      "deficientConditionStatus": null,
      "fulfilmentEvidence": {
        "roomAssignmentId": "b30c5e25-980d-44b5-a2ae-1b3f4ea8715c",
        "readinessConfirmed": true,
        "paymentStatusConfirmed": true,
        "ceilingProximityAddressed": true
      },
      "assignedAt": null,
      "acceptedAt": "2026-04-27T07:12:54.096Z",
      "acceptedBy": "e2e-fd-2",
      "fulfilledAt": "2026-04-27T07:12:54.124Z",
      "fulfilledBy": "e2e-fd-2",
      "closedAt": "2026-04-27T07:12:54.292Z",
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": null,
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T07:12:43.554Z",
      "createdBy": "e2e-fd-2",
      "stageContext": "S4"
    }
  ]
}
```

### S7 run night audit (last operating date)

- **Request**: `POST` `/night-audit/run` (actor `L2` / `e2e-fom-2`)

```json
{
  "body": {
    "operatingDate": "2026-04-27T00:00:00.000Z"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "e72d1b5d-c7be-43c3-929f-a02fcbee00e9",
  "operatingDate": "2026-04-27T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 3,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-27T07:12:54.374Z",
  "createdBy": "e2e-fom-2"
}
```

### S7 initiate H4

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/handoffs/h4` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "notes": "e2e pre-checkout handoff"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "4f2daf0f-8c94-43c9-bec2-1d58cfad9073",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "handoffType": "H4",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-2",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "notes": "e2e pre-checkout handoff"
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
  "createdAt": "2026-04-27T07:12:54.426Z",
  "createdBy": "e2e-fd-2",
  "stageContext": "S7"
}
```

### S7->S8 progress-stage (stay exit)

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/progress-stage` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "targetStage": "S8",
    "version": 7
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7a02c505-9743-4106-95b3-8fa48234310b",
  "inquiryId": "2b82882b-1694-4767-bff0-ee54dff9aeaa",
  "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S8",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T07:12:42.892Z",
  "updatedAt": "2026-04-27T07:12:54.466Z",
  "createdBy": "e2e-fd-2",
  "version": 8,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T07:12:54.292Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-2",
  "registrationCompletedAt": "2026-04-27T07:12:54.292Z",
  "registrationCompletedBy": "e2e-fd-2"
}
```

### S8 record key return

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/key-return` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "keyCountReturned": 2
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "1f3939dc-227a-40b5-8163-c956dd4a40a6",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f",
  "receivedBy": "e2e-fd-2",
  "returnedAt": "2026-04-27T07:12:54.512Z",
  "keyCountIssued": 2,
  "keyCountReturned": 2,
  "countReconciled": true,
  "reconciliationNote": null,
  "createdAt": "2026-04-27T07:12:54.514Z"
}
```

### S8 record room inspection

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/room-inspection` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "isDeferred": false,
    "deficientFlagStatus": "NOT_APPLICABLE",
    "damageFound": false
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "9c36bf85-5556-4dd7-9fea-6060f7d03cbd",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "roomId": "af1318b9-c409-4434-bb01-aee51cacaf6f",
  "segmentId": "db49f0ac-933c-4c2c-b588-52fded95f9fb",
  "inspectedBy": "e2e-fd-2",
  "inspectedAt": "2026-04-27T07:12:54.550Z",
  "isDeferred": false,
  "deficientFlagStatus": "NOT_APPLICABLE",
  "deficientConditionId": null,
  "inspectorAssessment": null,
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-04-27T07:12:54.552Z"
}
```

### S8 fulfil H4

- **Request**: `POST` `/handoffs/4f2daf0f-8c94-43c9-bec2-1d58cfad9073/fulfil` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "fulfilmentEvidence": {
      "chargesPostedConfirmation": true,
      "roomInspectionStatus": "RECORDED_OR_DEFERRED",
      "damageAssessmentStatus": "COMPLETE_OR_DEFERRED",
      "deficientFlagFinalStatus": "RECORDED"
    }
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "4f2daf0f-8c94-43c9-bec2-1d58cfad9073",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "handoffType": "H4",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-2",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "notes": "e2e pre-checkout handoff"
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
  "fulfilledAt": "2026-04-27T07:12:54.584Z",
  "fulfilledBy": "e2e-fd-2",
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
  "createdAt": "2026-04-27T07:12:54.426Z",
  "createdBy": "e2e-fd-2",
  "stageContext": "S7"
}
```

### S8 settle folio (DIRECT_BILL => OUTSTANDING)

- **Request**: `POST` `/folios/71c80d12-140c-4c72-85a0-c6dd1b752885/settle` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "settlementMethod": "DIRECT_BILL",
    "billingModelConfirmation": "DIRECT_BILL"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "71c80d12-140c-4c72-85a0-c6dd1b752885",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "state": "OUTSTANDING",
  "billingModel": "DIRECT_BILL",
  "createdAt": "2026-04-27T07:12:43.337Z",
  "createdBy": "e2e-fd-2",
  "convertedToLiveAt": "2026-04-27T07:12:54.302Z",
  "convertedBy": "e2e-fd-2",
  "closedAt": "2026-04-27T07:12:54.617Z",
  "closedBy": "e2e-fd-2",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "500",
  "advancePaymentReconciliationComplete": true
}
```

### S8->S9 progress-stage (closure stage)

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/progress-stage` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "targetStage": "S9",
    "version": 8
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7a02c505-9743-4106-95b3-8fa48234310b",
  "inquiryId": "2b82882b-1694-4767-bff0-ee54dff9aeaa",
  "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S9",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T07:12:42.892Z",
  "updatedAt": "2026-04-27T07:12:54.678Z",
  "createdBy": "e2e-fd-2",
  "version": 9,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T07:12:54.292Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-2",
  "registrationCompletedAt": "2026-04-27T07:12:54.292Z",
  "registrationCompletedBy": "e2e-fd-2"
}
```

### S9 fulfil H5

- **Request**: `POST` `/handoffs/43e61009-fab0-4770-9d4b-e62b78dd24b5/fulfil` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "fulfilmentEvidence": {
      "resolutionBasis": "DIRECT_BILL_INVOICE_DISPATCHED"
    }
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "43e61009-fab0-4770-9d4b-e62b78dd24b5",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "handoffType": "H5",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-2",
  "toRole": "FINANCE",
  "toActorId": null,
  "checklistContent": {
    "basis": "Checkout governed outstanding",
    "outstandingBalance": "500"
  },
  "deficientConditionStatus": null,
  "fulfilmentEvidence": {
    "resolutionBasis": "DIRECT_BILL_INVOICE_DISPATCHED"
  },
  "assignedAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "fulfilledAt": "2026-04-27T07:12:54.713Z",
  "fulfilledBy": "e2e-fd-2",
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
  "createdAt": "2026-04-27T07:12:54.679Z",
  "createdBy": "e2e-fd-2",
  "stageContext": "S8"
}
```

### S9 list invoices

- **Request**: `GET` `/folios/71c80d12-140c-4c72-85a0-c6dd1b752885/invoices` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
[
  {
    "id": "f5d2423f-8d66-4881-89c3-824e20ffbea2",
    "folioId": "71c80d12-140c-4c72-85a0-c6dd1b752885",
    "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
    "invoiceType": "FINAL",
    "state": "DISPATCHED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "final-v1",
    "issuedAt": "2026-04-27T07:12:54.616Z",
    "issuedBy": "e2e-fd-2",
    "dispatchedAt": "2026-04-27T07:12:54.616Z",
    "dispatchedBy": "e2e-fd-2",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "billingModel": "DIRECT_BILL",
      "settlementMethod": "DIRECT_BILL",
      "outstandingBalance": "500"
    },
    "createdAt": "2026-04-27T07:12:54.617Z"
  },
  {
    "id": "75d929f7-eea9-4d92-b882-86609451ddcc",
    "folioId": "71c80d12-140c-4c72-85a0-c6dd1b752885",
    "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
    "invoiceType": "PROFORMA",
    "state": "DRAFT",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "proforma-v1",
    "issuedAt": "2026-04-27T07:12:43.340Z",
    "issuedBy": "e2e-fd-2",
    "dispatchedAt": null,
    "dispatchedBy": null,
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "basis": "S3 setup"
    },
    "createdAt": "2026-04-27T07:12:43.342Z"
  }
]
```

### S9 dispatch invoice 75d929f7-eea9-4d92-b882-86609451ddcc

- **Request**: `POST` `/invoices/75d929f7-eea9-4d92-b882-86609451ddcc/dispatch` (actor `L1` / `e2e-fd-2`)

```json
{
  "body": {
    "dispatchedTo": "billing@example.com"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "75d929f7-eea9-4d92-b882-86609451ddcc",
  "folioId": "71c80d12-140c-4c72-85a0-c6dd1b752885",
  "entryId": "7a02c505-9743-4106-95b3-8fa48234310b",
  "invoiceType": "PROFORMA",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": "proforma-v1",
  "issuedAt": "2026-04-27T07:12:43.340Z",
  "issuedBy": "e2e-fd-2",
  "dispatchedAt": "2026-04-27T07:12:54.775Z",
  "dispatchedBy": "e2e-fd-2",
  "dispatchedTo": "billing@example.com",
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "basis": "S3 setup",
    "dispatchedAt": "2026-04-27T07:12:54.775Z",
    "dispatchedBy": "e2e-fd-2"
  },
  "createdAt": "2026-04-27T07:12:43.342Z"
}
```

### S9 close entry

- **Request**: `POST` `/entries/7a02c505-9743-4106-95b3-8fa48234310b/close` (actor `L2` / `e2e-fom-2`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
{
  "id": "7a02c505-9743-4106-95b3-8fa48234310b",
  "inquiryId": "2b82882b-1694-4767-bff0-ee54dff9aeaa",
  "guestProfileId": "06ccf167-0619-4686-b1bc-ad5cb463dcb9",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "CLOSED",
  "currentStage": "S9",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T07:12:42.892Z",
  "updatedAt": "2026-04-27T07:12:54.837Z",
  "createdBy": "e2e-fd-2",
  "version": 10,
  "closedAt": "2026-04-27T07:12:54.836Z",
  "closedBy": "e2e-fom-2",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T07:12:54.292Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-2",
  "registrationCompletedAt": "2026-04-27T07:12:54.292Z",
  "registrationCompletedBy": "e2e-fd-2"
}
```
