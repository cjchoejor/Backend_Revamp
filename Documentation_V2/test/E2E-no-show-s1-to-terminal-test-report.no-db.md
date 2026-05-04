# E2E no-show flow report (S1 → TERMINAL) — no DB diffs

- **Ran at**: 2026-04-27T10:17:15.072Z
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `3b94c65d-e520-4c7b-809a-4010e9500014`
- **Inquiry ID**: `cf153efc-c5a2-42d3-9e20-c8574542bdf8`
- **GuestProfile ID (seeded)**: `41f16a38-0844-426b-a9b8-f97c51b6e8d5`

## Steps

### S1 create inquiry

- **Request**: `POST` `/inquiries` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "guestProfileId": "41f16a38-0844-426b-a9b8-f97c51b6e8d5",
    "sourceChannel": "WALK_IN",
    "notes": "e2e no-show flow"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "cf153efc-c5a2-42d3-9e20-c8574542bdf8",
  "referenceNumber": "INQ-1777285035201-36892",
  "guestProfileId": "41f16a38-0844-426b-a9b8-f97c51b6e8d5",
  "agentProfileId": null,
  "sourceChannel": "WALK_IN",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": "e2e no-show flow",
  "createdAt": "2026-04-27T10:17:15.202Z",
  "updatedAt": "2026-04-27T10:17:15.202Z",
  "createdBy": "e2e-fd-4",
  "parkedAt": null,
  "parkedBy": null
}
```

### S1 create entry

- **Request**: `POST` `/entries` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "inquiryId": "cf153efc-c5a2-42d3-9e20-c8574542bdf8",
    "useType": "LEISURE",
    "checkInDate": "2026-04-27T00:00:00.000Z",
    "checkOutDate": "2026-04-28T00:00:00.000Z",
    "guestCount": 1,
    "otaSource": false
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "inquiryId": "cf153efc-c5a2-42d3-9e20-c8574542bdf8",
  "guestProfileId": "41f16a38-0844-426b-a9b8-f97c51b6e8d5",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S1",
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
  "createdAt": "2026-04-27T10:17:15.229Z",
  "updatedAt": "2026-04-27T10:17:15.229Z",
  "createdBy": "e2e-fd-4",
  "version": 1,
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

### S1 availability search

- **Request**: `POST` `/availability/search` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
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
  "configurationId": "7768c516-a0ce-4174-b1d6-7ec38eb10bb7",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "queriedAt": "2026-04-27T10:17:15.250Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "8b6cc510-831e-4e25-a33a-45ef6dafe8aa",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "8b6cc510-831e-4e25-a33a-45ef6dafe8aa"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "776e4772-ffdf-4ed9-837e-574bcd0f3a42",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "776e4772-ffdf-4ed9-837e-574bcd0f3a42"
      },
      {
        "inventoryId": "35f0cfc1-5e28-4f4f-90ca-18638f483d6b",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "35f0cfc1-5e28-4f4f-90ca-18638f483d6b"
      },
      {
        "inventoryId": "f275172f-5a57-4add-983d-b221e067d192",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "f275172f-5a57-4add-983d-b221e067d192"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "97144f7b-792b-4b7e-a1ba-23625fa79d0c",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "97144f7b-792b-4b7e-a1ba-23625fa79d0c"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-27T10:17:15.249Z",
    "isRevalidationRequired": false
  }
}
```

### S1 select availability option

- **Request**: `PATCH` `/availability/configurations/7768c516-a0ce-4174-b1d6-7ec38eb10bb7/select` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "roomId": "8b6cc510-831e-4e25-a33a-45ef6dafe8aa"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7768c516-a0ce-4174-b1d6-7ec38eb10bb7",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
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
        "inventoryId": "8b6cc510-831e-4e25-a33a-45ef6dafe8aa"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "97144f7b-792b-4b7e-a1ba-23625fa79d0c",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-27T10:17:15.249Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "776e4772-ffdf-4ed9-837e-574bcd0f3a42",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "35f0cfc1-5e28-4f4f-90ca-18638f483d6b",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "f275172f-5a57-4add-983d-b221e067d192",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "8b6cc510-831e-4e25-a33a-45ef6dafe8aa",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:17:15.250Z",
  "createdBy": "e2e-fd-4"
}
```

### S1->S2 progress-stage

- **Request**: `POST` `/entries/3b94c65d-e520-4c7b-809a-4010e9500014/progress-stage` (actor `L1` / `e2e-fd-4`)

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
  "id": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "inquiryId": "cf153efc-c5a2-42d3-9e20-c8574542bdf8",
  "guestProfileId": "41f16a38-0844-426b-a9b8-f97c51b6e8d5",
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
  "createdAt": "2026-04-27T10:17:15.229Z",
  "updatedAt": "2026-04-27T10:17:15.294Z",
  "createdBy": "e2e-fd-4",
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

- **Request**: `POST` `/entries/3b94c65d-e520-4c7b-809a-4010e9500014/quotations` (actor `L1` / `e2e-fd-4`)

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
  "id": "c48aa033-ac17-4ace-9e6e-bed19a8bb5a7",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "segmentId": "c77b6743-d7a7-42c9-88ff-4da0502b895f",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "3e145c48-1aed-41b7-8e5e-c0e23bd7f062",
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
  "createdAt": "2026-04-27T10:17:15.308Z",
  "createdBy": "e2e-fd-4"
}
```

### S2 send quotation

- **Request**: `POST` `/quotations/c48aa033-ac17-4ace-9e6e-bed19a8bb5a7/send` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "c48aa033-ac17-4ace-9e6e-bed19a8bb5a7",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "segmentId": "c77b6743-d7a7-42c9-88ff-4da0502b895f",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "3e145c48-1aed-41b7-8e5e-c0e23bd7f062",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T10:17:15.314Z",
  "sentAt": "2026-04-27T10:17:15.314Z",
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:17:15.308Z",
  "createdBy": "e2e-fd-4"
}
```

### S2 accept quotation

- **Request**: `POST` `/quotations/c48aa033-ac17-4ace-9e6e-bed19a8bb5a7/accept` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "c48aa033-ac17-4ace-9e6e-bed19a8bb5a7",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "segmentId": "c77b6743-d7a7-42c9-88ff-4da0502b895f",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "ACCEPTED",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "3e145c48-1aed-41b7-8e5e-c0e23bd7f062",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T10:17:15.314Z",
  "sentAt": "2026-04-27T10:17:15.314Z",
  "sentTo": null,
  "communicationRecordId": "dc30f3f7-9c86-47f1-8f61-d9f6fe4ca141",
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": "2026-04-27T10:17:15.349Z",
  "acceptedBy": "e2e-fd-4",
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:17:15.308Z",
  "createdBy": "e2e-fd-4"
}
```

### S2->S3 progress-stage

- **Request**: `POST` `/entries/3b94c65d-e520-4c7b-809a-4010e9500014/progress-stage` (actor `L1` / `e2e-fd-4`)

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
  "id": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "inquiryId": "cf153efc-c5a2-42d3-9e20-c8574542bdf8",
  "guestProfileId": "41f16a38-0844-426b-a9b8-f97c51b6e8d5",
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
  "createdAt": "2026-04-27T10:17:15.229Z",
  "updatedAt": "2026-04-27T10:17:15.376Z",
  "createdBy": "e2e-fd-4",
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

- **Request**: `POST` `/entries/3b94c65d-e520-4c7b-809a-4010e9500014/folio/provisional` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "billingModel": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "1ea2d2fc-83cc-407a-898e-a4527fd61f2a",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:17:15.388Z",
  "createdBy": "e2e-fd-4",
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
      "id": "9b400a28-04ff-42de-a607-6aff999ef27c",
      "folioId": "1ea2d2fc-83cc-407a-898e-a4527fd61f2a",
      "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T10:17:15.391Z",
      "issuedBy": "e2e-fd-4",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T10:17:15.392Z"
    }
  ]
}
```

### S3 record advance payment

- **Request**: `POST` `/folios/1ea2d2fc-83cc-407a-898e-a4527fd61f2a/payments` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
    "amount": 500,
    "notes": "advance for no-show scenario"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "2a322088-4249-425b-ba7f-1a7b533b4cac",
  "folioId": "1ea2d2fc-83cc-407a-898e-a4527fd61f2a",
  "invoiceId": null,
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "amount": "500",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-27T10:17:15.406Z",
  "receivedAt": "2026-04-27T10:17:15.405Z",
  "recordedBy": "e2e-fd-4",
  "stage": "S3",
  "notes": "advance for no-show scenario"
}
```

### S3 reconcile advance payment

- **Request**: `POST` `/folios/1ea2d2fc-83cc-407a-898e-a4527fd61f2a/advance-payment/reconcile` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
    "note": "reconcile for no-show scenario"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "1ea2d2fc-83cc-407a-898e-a4527fd61f2a",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:17:15.388Z",
  "createdBy": "e2e-fd-4",
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

- **Request**: `POST` `/entries/3b94c65d-e520-4c7b-809a-4010e9500014/disclosures/cancellation` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "noShowTreatmentStatement": "Standard no-show policy",
    "disclosedTerms": {
      "sameDayPenaltyAmount": 200
    }
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "ca93e6ac-5554-4132-b512-605e61a8b3e0",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "segmentId": "c77b6743-d7a7-42c9-88ff-4da0502b895f",
  "noShowTreatmentStatement": "Standard no-show policy",
  "disclosedTerms": {
    "sameDayPenaltyAmount": 200
  },
  "disclosedAt": "2026-04-27T10:17:15.423Z",
  "disclosedBy": "e2e-fd-4"
}
```

### S3 committed hold

- **Request**: `POST` `/entries/3b94c65d-e520-4c7b-809a-4010e9500014/holds/committed` (actor `L1` / `e2e-fd-4`)

```json
{
  "body": {
    "roomId": "8b6cc510-831e-4e25-a33a-45ef6dafe8aa",
    "commercialJustification": "No-show scenario hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "c17a005a-5bcc-49fe-a598-226c02a2e867",
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "segmentId": "c77b6743-d7a7-42c9-88ff-4da0502b895f",
  "roomId": "8b6cc510-831e-4e25-a33a-45ef6dafe8aa",
  "spaceId": null,
  "roomTypeId": "3e145c48-1aed-41b7-8e5e-c0e23bd7f062",
  "state": "PLACED",
  "placedAt": "2026-04-27T10:17:15.438Z",
  "placedBy": "e2e-fd-4",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "No-show scenario hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-27T11:17:15.438Z"
}
```

### S3->S4 confirm reservation

- **Request**: `POST` `/entries/3b94c65d-e520-4c7b-809a-4010e9500014/confirm` (actor `L1` / `e2e-fd-4`)

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
    "id": "5ab73fa0-1f5b-4d4a-b2eb-6c75cd2507fc",
    "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
    "segmentId": "c77b6743-d7a7-42c9-88ff-4da0502b895f",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {
      "sameDayPenaltyAmount": 200
    },
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-04-27T00:00:00.000Z",
    "frozenCheckOutDate": "2026-04-28T00:00:00.000Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-04-27T10:17:15.477Z",
    "confirmedBy": "e2e-fd-4",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-27T10:17:15.478Z"
  },
  "entry": {
    "id": "3b94c65d-e520-4c7b-809a-4010e9500014",
    "inquiryId": "cf153efc-c5a2-42d3-9e20-c8574542bdf8",
    "guestProfileId": "41f16a38-0844-426b-a9b8-f97c51b6e8d5",
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
    "createdAt": "2026-04-27T10:17:15.229Z",
    "updatedAt": "2026-04-27T10:17:15.490Z",
    "createdBy": "e2e-fd-4",
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
  "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014"
}
```

### TEST SETUP (DB): mark noShowCutoffReachedAt

- **Request**: `DB` `Entry.noShowCutoffReachedAt` (actor `L2` / `SYSTEM`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
{
  "ok": true
}
```

### S5 determine no-show (SUB_PATH_1)

- **Request**: `POST` `/entries/3b94c65d-e520-4c7b-809a-4010e9500014/no-show` (actor `L2` / `e2e-fom-4`)

```json
{
  "body": {
    "determinationPath": "SUB_PATH_1",
    "contactAttemptLog": [
      {
        "channel": "PHONE",
        "attemptedAt": "2026-04-27T10:17:25.704Z",
        "outcome": "NO_ANSWER"
      }
    ],
    "decisionReason": "Guest did not arrive within cutoff window"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "3b94c65d-e520-4c7b-809a-4010e9500014",
  "inquiryId": "cf153efc-c5a2-42d3-9e20-c8574542bdf8",
  "guestProfileId": "41f16a38-0844-426b-a9b8-f97c51b6e8d5",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "TERMINAL",
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
  "createdAt": "2026-04-27T10:17:15.229Z",
  "updatedAt": "2026-04-27T10:17:25.722Z",
  "createdBy": "e2e-fd-4",
  "version": 6,
  "closedAt": "2026-04-27T10:17:25.718Z",
  "closedBy": "e2e-fom-4",
  "noShowCutoffReachedAt": "2026-04-27T10:17:25.700Z",
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": null,
  "keysIssuedCount": null,
  "keysIssuedBy": null,
  "registrationCompletedAt": null,
  "registrationCompletedBy": null,
  "noShowDetermination": {
    "id": "c6dc78ea-5ad9-4cfb-9deb-f9d8fd0a00e5",
    "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
    "determinationPath": "SUB_PATH_1",
    "fomActorId": "e2e-fom-4",
    "contactAttemptLog": [
      {
        "channel": "PHONE",
        "outcome": "NO_ANSWER",
        "attemptedAt": "2026-04-27T10:17:25.704Z"
      }
    ],
    "decisionReason": "Guest did not arrive within cutoff window",
    "otaNotificationRequired": false,
    "otaNotificationStatus": null,
    "determinedAt": "2026-04-27T10:17:25.722Z",
    "createdAt": "2026-04-27T10:17:25.722Z",
    "createdBy": "e2e-fom-4"
  },
  "folio": {
    "id": "1ea2d2fc-83cc-407a-898e-a4527fd61f2a",
    "entryId": "3b94c65d-e520-4c7b-809a-4010e9500014",
    "state": "NO_SHOW_CLOSED",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-27T10:17:15.388Z",
    "createdBy": "e2e-fd-4",
    "convertedToLiveAt": null,
    "convertedBy": null,
    "closedAt": "2026-04-27T10:17:25.718Z",
    "closedBy": "e2e-fom-4",
    "noShowPenaltyAmount": "200",
    "noShowAdvancePaymentAmount": "500",
    "noShowNetPosition": "300",
    "noShowFomDetermination": "e2e-fom-4",
    "outstandingBalance": "0",
    "advancePaymentReconciliationComplete": true
  }
}
```
