# E2E deferred inspection + W9 lapse + close — no DB diffs

- **Ran at**: 2026-04-27T11:30:02.412Z
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `5f1f945e-6cd4-48da-a160-2bbb5f82d5c7`
- **Inquiry ID**: `8b7db71a-8e5e-4437-b602-f837e6511d47`
- **GuestProfile ID (seeded)**: `22399006-e274-4f9e-a530-0dd9c550f85c`

## Steps

### S1 create inquiry

- **Request**: `POST` `/inquiries` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
    "sourceChannel": "WALK_IN",
    "notes": "e2e deferred inspection lapse"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "referenceNumber": "INQ-1777289402531-387637",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
  "agentProfileId": null,
  "sourceChannel": "WALK_IN",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": "e2e deferred inspection lapse",
  "createdAt": "2026-04-27T11:30:02.532Z",
  "updatedAt": "2026-04-27T11:30:02.532Z",
  "createdBy": "e2e-fd-9",
  "parkedAt": null,
  "parkedBy": null
}
```

### S1 create entry

- **Request**: `POST` `/entries` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
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
  "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "createdAt": "2026-04-27T11:30:02.557Z",
  "updatedAt": "2026-04-27T11:30:02.557Z",
  "createdBy": "e2e-fd-9",
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

- **Request**: `POST` `/availability/search` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
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
  "configurationId": "0a2f88d7-1b26-4923-95f0-d2e0b104a5de",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "queriedAt": "2026-04-27T11:30:02.577Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "03553135-09dc-4618-838d-6725a81ab847",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "03553135-09dc-4618-838d-6725a81ab847"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "1e9ac0c9-0d6a-4548-bba2-726b68a36705",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "1e9ac0c9-0d6a-4548-bba2-726b68a36705"
      },
      {
        "inventoryId": "fdb7b90f-424a-4c19-bad8-ae97ffc19585",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "fdb7b90f-424a-4c19-bad8-ae97ffc19585"
      },
      {
        "inventoryId": "3d384d6e-f5f5-4ed9-a715-73874d8b2948",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "3d384d6e-f5f5-4ed9-a715-73874d8b2948"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "379bff75-3d00-4561-9297-9a7abf259b73",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "379bff75-3d00-4561-9297-9a7abf259b73"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-27T11:30:02.576Z",
    "isRevalidationRequired": false
  }
}
```

### S1 select availability option

- **Request**: `PATCH` `/availability/configurations/0a2f88d7-1b26-4923-95f0-d2e0b104a5de/select` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "roomId": "03553135-09dc-4618-838d-6725a81ab847"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "0a2f88d7-1b26-4923-95f0-d2e0b104a5de",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
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
        "inventoryId": "03553135-09dc-4618-838d-6725a81ab847"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "379bff75-3d00-4561-9297-9a7abf259b73",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-27T11:30:02.576Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "1e9ac0c9-0d6a-4548-bba2-726b68a36705",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "fdb7b90f-424a-4c19-bad8-ae97ffc19585",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "3d384d6e-f5f5-4ed9-a715-73874d8b2948",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "03553135-09dc-4618-838d-6725a81ab847",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T11:30:02.577Z",
  "createdBy": "e2e-fd-9"
}
```

### S1->S2 progress-stage

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/progress-stage` (actor `L1` / `e2e-fd-9`)

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
  "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "createdAt": "2026-04-27T11:30:02.557Z",
  "updatedAt": "2026-04-27T11:30:02.616Z",
  "createdBy": "e2e-fd-9",
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

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/quotations` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "nightlyRate": 100,
    "currency": "BTN",
    "notes": "quote"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "05ee3396-4141-4e71-a6e3-9e573afcff79",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "segmentId": "5de1df8f-d023-4009-a3ea-97001690b1a9",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "quote",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "db11352d-935a-4904-b1ad-fed6c90e0c57",
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
  "createdAt": "2026-04-27T11:30:02.630Z",
  "createdBy": "e2e-fd-9"
}
```

### S2 send quotation

- **Request**: `POST` `/quotations/05ee3396-4141-4e71-a6e3-9e573afcff79/send` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "05ee3396-4141-4e71-a6e3-9e573afcff79",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "segmentId": "5de1df8f-d023-4009-a3ea-97001690b1a9",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "notes": "quote",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "db11352d-935a-4904-b1ad-fed6c90e0c57",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T11:30:02.636Z",
  "sentAt": "2026-04-27T11:30:02.636Z",
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T11:30:02.630Z",
  "createdBy": "e2e-fd-9"
}
```

### S2 accept quotation

- **Request**: `POST` `/quotations/05ee3396-4141-4e71-a6e3-9e573afcff79/accept` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "05ee3396-4141-4e71-a6e3-9e573afcff79",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "segmentId": "5de1df8f-d023-4009-a3ea-97001690b1a9",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "ACCEPTED",
  "commercialTerms": {
    "notes": "quote",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "db11352d-935a-4904-b1ad-fed6c90e0c57",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T11:30:02.636Z",
  "sentAt": "2026-04-27T11:30:02.636Z",
  "sentTo": null,
  "communicationRecordId": "16a5e9a5-7c17-4deb-8151-a619b8dd8d16",
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": "2026-04-27T11:30:02.675Z",
  "acceptedBy": "e2e-fd-9",
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T11:30:02.630Z",
  "createdBy": "e2e-fd-9"
}
```

### S2->S3 progress-stage

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/progress-stage` (actor `L1` / `e2e-fd-9`)

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
  "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "createdAt": "2026-04-27T11:30:02.557Z",
  "updatedAt": "2026-04-27T11:30:02.700Z",
  "createdBy": "e2e-fd-9",
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

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/folio/provisional` (actor `L1` / `e2e-fd-9`)

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
  "id": "e6c0e1e0-43d4-4be4-be0a-8c2571e13886",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:30:02.708Z",
  "createdBy": "e2e-fd-9",
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
      "id": "876ddfed-44e7-44d3-b6ff-35326ab4bac5",
      "folioId": "e6c0e1e0-43d4-4be4-be0a-8c2571e13886",
      "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T11:30:02.711Z",
      "issuedBy": "e2e-fd-9",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T11:30:02.712Z"
    }
  ]
}
```

### S3 record advance payment

- **Request**: `POST` `/folios/e6c0e1e0-43d4-4be4-be0a-8c2571e13886/payments` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
    "amount": 500,
    "notes": "advance"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "8b338916-65bb-4c4b-825c-7f3eae1c34d0",
  "folioId": "e6c0e1e0-43d4-4be4-be0a-8c2571e13886",
  "invoiceId": null,
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "amount": "500",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-27T11:30:02.726Z",
  "receivedAt": "2026-04-27T11:30:02.725Z",
  "recordedBy": "e2e-fd-9",
  "stage": "S3",
  "notes": "advance"
}
```

### S3 reconcile advance payment

- **Request**: `POST` `/folios/e6c0e1e0-43d4-4be4-be0a-8c2571e13886/advance-payment/reconcile` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
    "note": "reconcile"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "e6c0e1e0-43d4-4be4-be0a-8c2571e13886",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:30:02.708Z",
  "createdBy": "e2e-fd-9",
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

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/disclosures/cancellation` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "noShowTreatmentStatement": "terms",
    "disclosedTerms": {
      "windowHours": 24
    }
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "c0459e41-868b-4755-81df-f9e757eeb6e5",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "segmentId": "5de1df8f-d023-4009-a3ea-97001690b1a9",
  "noShowTreatmentStatement": "terms",
  "disclosedTerms": {
    "windowHours": 24
  },
  "disclosedAt": "2026-04-27T11:30:02.740Z",
  "disclosedBy": "e2e-fd-9"
}
```

### S3 committed hold

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/holds/committed` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "roomId": "03553135-09dc-4618-838d-6725a81ab847",
    "commercialJustification": "hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "980e8777-10cf-45e6-9cbe-214e510dad69",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "segmentId": "5de1df8f-d023-4009-a3ea-97001690b1a9",
  "roomId": "03553135-09dc-4618-838d-6725a81ab847",
  "spaceId": null,
  "roomTypeId": "db11352d-935a-4904-b1ad-fed6c90e0c57",
  "state": "PLACED",
  "placedAt": "2026-04-27T11:30:02.762Z",
  "placedBy": "e2e-fd-9",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-27T12:30:02.762Z"
}
```

### S3->S4 confirm reservation

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/confirm` (actor `L1` / `e2e-fd-9`)

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
    "id": "9c2aea4e-f73c-4921-8291-0badf584f0ad",
    "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
    "segmentId": "5de1df8f-d023-4009-a3ea-97001690b1a9",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {
      "windowHours": 24
    },
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-04-27T00:00:00.000Z",
    "frozenCheckOutDate": "2026-04-28T00:00:00.000Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-04-27T11:30:02.800Z",
    "confirmedBy": "e2e-fd-9",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-27T11:30:02.801Z"
  },
  "entry": {
    "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
    "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
    "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
    "createdAt": "2026-04-27T11:30:02.557Z",
    "updatedAt": "2026-04-27T11:30:02.811Z",
    "createdBy": "e2e-fd-9",
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
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7"
}
```

### S5 complete pre-arrival task c1f88e6e-0131-4cd1-85cb-f94f87254dbc

- **Request**: `PATCH` `/pre-arrival-tasks/c1f88e6e-0131-4cd1-85cb-f94f87254dbc` (actor `L1` / `e2e-fd-9`)

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
  "id": "c1f88e6e-0131-4cd1-85cb-f94f87254dbc",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "taskType": "PAYMENT_RECONCILIATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:30:13.125Z",
  "completedBy": "e2e-fd-9",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:30:13.072Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 7e93f8ec-7424-4c6f-81af-4b3eb51d0114

- **Request**: `PATCH` `/pre-arrival-tasks/7e93f8ec-7424-4c6f-81af-4b3eb51d0114` (actor `L1` / `e2e-fd-9`)

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
  "id": "7e93f8ec-7424-4c6f-81af-4b3eb51d0114",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "taskType": "NIGHT_AUDIT_TIMER_REGISTRATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:30:13.129Z",
  "completedBy": "e2e-fd-9",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:30:13.072Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 58037140-6f50-473b-9430-ff1c5cf0661d

- **Request**: `PATCH` `/pre-arrival-tasks/58037140-6f50-473b-9430-ff1c5cf0661d` (actor `L1` / `e2e-fd-9`)

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
  "id": "58037140-6f50-473b-9430-ff1c5cf0661d",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "taskType": "BED_CONFIGURATION_CHANGE",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:30:13.133Z",
  "completedBy": "e2e-fd-9",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:30:13.072Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 2d781983-ba04-456b-b185-b5727653589e

- **Request**: `PATCH` `/pre-arrival-tasks/2d781983-ba04-456b-b185-b5727653589e` (actor `L1` / `e2e-fd-9`)

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
  "id": "2d781983-ba04-456b-b185-b5727653589e",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "taskType": "PRE_ARRIVAL_COMMUNICATION",
  "category": "COMMUNICATION",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:30:13.137Z",
  "completedBy": "e2e-fd-9",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:30:13.072Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task effe804f-1dc0-4a98-830a-3cdd87abbd1d

- **Request**: `PATCH` `/pre-arrival-tasks/effe804f-1dc0-4a98-830a-3cdd87abbd1d` (actor `L1` / `e2e-fd-9`)

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
  "id": "effe804f-1dc0-4a98-830a-3cdd87abbd1d",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "taskType": "SPECIAL_REQUEST_FULFILMENT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:30:13.141Z",
  "completedBy": "e2e-fd-9",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:30:13.072Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 30a54b5f-7245-4986-a7cb-4f078bae44ea

- **Request**: `PATCH` `/pre-arrival-tasks/30a54b5f-7245-4986-a7cb-4f078bae44ea` (actor `L1` / `e2e-fd-9`)

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
  "id": "30a54b5f-7245-4986-a7cb-4f078bae44ea",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "taskType": "LATE_ARRIVAL_MEAL_COORDINATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:30:13.146Z",
  "completedBy": "e2e-fd-9",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:30:13.072Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task c8390a86-ca28-42fb-904e-5acf6cd8743d

- **Request**: `PATCH` `/pre-arrival-tasks/c8390a86-ca28-42fb-904e-5acf6cd8743d` (actor `L1` / `e2e-fd-9`)

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
  "id": "c8390a86-ca28-42fb-904e-5acf6cd8743d",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "taskType": "SITE_VISIT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:30:13.150Z",
  "completedBy": "e2e-fd-9",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:30:13.072Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task d7ff5b42-4bfa-4b32-bfb6-9f1e032f195c

- **Request**: `PATCH` `/pre-arrival-tasks/d7ff5b42-4bfa-4b32-bfb6-9f1e032f195c` (actor `L1` / `e2e-fd-9`)

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
  "id": "d7ff5b42-4bfa-4b32-bfb6-9f1e032f195c",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "taskType": "UNIT_READINESS_VERIFICATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:30:13.154Z",
  "completedBy": "e2e-fd-9",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:30:13.072Z",
  "createdBy": "SYSTEM"
}
```

### S5 room assignment

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/room-assignments` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "roomId": "03553135-09dc-4618-838d-6725a81ab847",
    "notes": "assign"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "ab2b8f6f-6944-43dd-a82e-b7eedbd45ed6",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "roomId": "03553135-09dc-4618-838d-6725a81ab847",
  "assignedAt": "2026-04-27T11:30:13.162Z",
  "assignedBy": "e2e-fd-9",
  "deficientAtAssignment": false,
  "deficientConditionRecordId": null,
  "acknowledgementActorId": null,
  "acknowledgementAt": null,
  "notes": "assign",
  "createdAt": "2026-04-27T11:30:13.162Z"
}
```

### S5 accept H1

- **Request**: `POST` `/handoffs/79589a8f-6aca-4a23-bf07-883541eb73f5/accept` (actor `L1` / `e2e-fd-9`)

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
  "id": "79589a8f-6aca-4a23-bf07-883541eb73f5",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "handoffType": "H1",
  "state": "ACCEPTED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-9",
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
  "acceptedAt": "2026-04-27T11:30:13.174Z",
  "acceptedBy": "e2e-fd-9",
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
  "createdAt": "2026-04-27T11:30:02.809Z",
  "createdBy": "e2e-fd-9",
  "stageContext": "S4"
}
```

### S5 fulfil H1

- **Request**: `POST` `/handoffs/79589a8f-6aca-4a23-bf07-883541eb73f5/fulfil` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "fulfilmentEvidence": {
      "roomAssignmentId": "ab2b8f6f-6944-43dd-a82e-b7eedbd45ed6",
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
  "id": "79589a8f-6aca-4a23-bf07-883541eb73f5",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "handoffType": "H1",
  "state": "FULFILLED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-9",
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
    "roomAssignmentId": "ab2b8f6f-6944-43dd-a82e-b7eedbd45ed6",
    "readinessConfirmed": true,
    "paymentStatusConfirmed": true,
    "ceilingProximityAddressed": true
  },
  "assignedAt": null,
  "acceptedAt": "2026-04-27T11:30:13.174Z",
  "acceptedBy": "e2e-fd-9",
  "fulfilledAt": "2026-04-27T11:30:13.178Z",
  "fulfilledBy": "e2e-fd-9",
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
  "createdAt": "2026-04-27T11:30:02.809Z",
  "createdBy": "e2e-fd-9",
  "stageContext": "S4"
}
```

### S5->S6 progress-stage

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/progress-stage` (actor `L1` / `e2e-fd-9`)

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
  "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "createdAt": "2026-04-27T11:30:02.557Z",
  "updatedAt": "2026-04-27T11:30:13.192Z",
  "createdBy": "e2e-fd-9",
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

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/handoffs/h2` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "roomNumber": "401",
    "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
    "deficientConditionStatus": null
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "9437f922-7b7f-4531-9245-2a0a5c15b5ed",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "handoffType": "H2",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-9",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "roomNumber": "401",
    "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "slaDeadlineAt": "2026-04-27T12:30:13.206Z",
  "isAutoFulfilled": false,
  "createdAt": "2026-04-27T11:30:13.207Z",
  "createdBy": "e2e-fd-9",
  "stageContext": "S6"
}
```

### S6 verify guest identity

- **Request**: `POST` `/guest-profiles/22399006-e274-4f9e-a530-0dd9c550f85c/verify-identity` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
    "verificationPath": "FIRST_TIME",
    "documentType": "PASSPORT",
    "documentNumber": "E2E-1777289413214",
    "issuingCountry": "BT"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "identityVerifiedAt": "2026-04-27T11:30:13.220Z",
  "identityVerifiedBy": "e2e-fd-9",
  "identityVerificationPath": "FIRST_TIME",
  "createdAt": "2026-04-27T11:30:00.850Z",
  "updatedAt": "2026-04-27T11:30:13.220Z",
  "createdBy": "actor-seed-system"
}
```

### S6->S7 progress-stage

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/progress-stage` (actor `L1` / `e2e-fd-9`)

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
  "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "createdAt": "2026-04-27T11:30:02.557Z",
  "updatedAt": "2026-04-27T11:30:13.240Z",
  "createdBy": "e2e-fd-9",
  "version": 7,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:30:13.240Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-9",
  "registrationCompletedAt": "2026-04-27T11:30:13.240Z",
  "registrationCompletedBy": "e2e-fd-9",
  "folio": {
    "id": "e6c0e1e0-43d4-4be4-be0a-8c2571e13886",
    "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
    "state": "LIVE",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-27T11:30:02.708Z",
    "createdBy": "e2e-fd-9",
    "convertedToLiveAt": "2026-04-27T11:30:13.247Z",
    "convertedBy": "e2e-fd-9",
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
    "id": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
    "identityVerifiedAt": "2026-04-27T11:30:13.220Z",
    "identityVerifiedBy": "e2e-fd-9",
    "identityVerificationPath": "FIRST_TIME",
    "createdAt": "2026-04-27T11:30:00.850Z",
    "updatedAt": "2026-04-27T11:30:13.220Z",
    "createdBy": "actor-seed-system"
  },
  "handoffs": [
    {
      "id": "4e98a846-7f0a-435e-bb37-f93ff7bb1aa1",
      "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
      "handoffType": "H3",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-9",
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
        "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
      "slaDeadlineAt": "2026-04-27T12:30:13.240Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:30:13.245Z",
      "createdBy": "e2e-fd-9",
      "stageContext": "S6"
    },
    {
      "id": "9437f922-7b7f-4531-9245-2a0a5c15b5ed",
      "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
      "handoffType": "H2",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-9",
      "toRole": "HOUSEKEEPING",
      "toActorId": null,
      "checklistContent": {
        "roomNumber": "401",
        "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
      "slaDeadlineAt": "2026-04-27T12:30:13.206Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:30:13.207Z",
      "createdBy": "e2e-fd-9",
      "stageContext": "S6"
    },
    {
      "id": "79589a8f-6aca-4a23-bf07-883541eb73f5",
      "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
      "handoffType": "H1",
      "state": "CLOSED",
      "fromRole": "RESERVATIONS",
      "fromActorId": "e2e-fd-9",
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
        "roomAssignmentId": "ab2b8f6f-6944-43dd-a82e-b7eedbd45ed6",
        "readinessConfirmed": true,
        "paymentStatusConfirmed": true,
        "ceilingProximityAddressed": true
      },
      "assignedAt": null,
      "acceptedAt": "2026-04-27T11:30:13.174Z",
      "acceptedBy": "e2e-fd-9",
      "fulfilledAt": "2026-04-27T11:30:13.178Z",
      "fulfilledBy": "e2e-fd-9",
      "closedAt": "2026-04-27T11:30:13.240Z",
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": null,
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:30:02.809Z",
      "createdBy": "e2e-fd-9",
      "stageContext": "S4"
    }
  ]
}
```

### S7 run night audit

- **Request**: `POST` `/night-audit/run` (actor `L2` / `e2e-fom-9`)

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
  "id": "095d0f80-73ab-4b6b-b756-a12c01b585a5",
  "operatingDate": "2026-04-27T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 3,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-27T11:30:13.297Z",
  "createdBy": "e2e-fom-9"
}
```

### S7 initiate H4

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/handoffs/h4` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "notes": "h4"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "5994f63c-f692-40a6-9fe5-07cc42670e8d",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "handoffType": "H4",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-9",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "notes": "h4"
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
  "createdAt": "2026-04-27T11:30:13.312Z",
  "createdBy": "e2e-fd-9",
  "stageContext": "S7"
}
```

### S7->S8 progress-stage

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/progress-stage` (actor `L1` / `e2e-fd-9`)

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
  "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "createdAt": "2026-04-27T11:30:02.557Z",
  "updatedAt": "2026-04-27T11:30:13.328Z",
  "createdBy": "e2e-fd-9",
  "version": 8,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:30:13.240Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-9",
  "registrationCompletedAt": "2026-04-27T11:30:13.240Z",
  "registrationCompletedBy": "e2e-fd-9"
}
```

### S8 key return

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/key-return` (actor `L1` / `e2e-fd-9`)

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
  "id": "5e98e36b-b7f7-40c2-9fb6-695259e162f7",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "roomId": "03553135-09dc-4618-838d-6725a81ab847",
  "receivedBy": "e2e-fd-9",
  "returnedAt": "2026-04-27T11:30:13.346Z",
  "keyCountIssued": 2,
  "keyCountReturned": 2,
  "countReconciled": true,
  "reconciliationNote": null,
  "createdAt": "2026-04-27T11:30:13.347Z"
}
```

### S8 deferred inspection

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/room-inspection` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "isDeferred": true,
    "deficientFlagStatus": "NOT_APPLICABLE",
    "damageFound": false
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "d3bf3596-3ada-4929-ab93-d773cdf9eacd",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "roomId": "03553135-09dc-4618-838d-6725a81ab847",
  "segmentId": "5de1df8f-d023-4009-a3ea-97001690b1a9",
  "inspectedBy": "e2e-fd-9",
  "inspectedAt": "2026-04-27T11:30:13.355Z",
  "isDeferred": true,
  "deficientFlagStatus": "NOT_APPLICABLE",
  "deficientConditionId": null,
  "inspectorAssessment": null,
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-04-27T11:30:13.356Z"
}
```

### S8 fulfil H4

- **Request**: `POST` `/handoffs/5994f63c-f692-40a6-9fe5-07cc42670e8d/fulfil` (actor `L1` / `e2e-fd-9`)

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
  "id": "5994f63c-f692-40a6-9fe5-07cc42670e8d",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "handoffType": "H4",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-9",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "notes": "h4"
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
  "fulfilledAt": "2026-04-27T11:30:13.366Z",
  "fulfilledBy": "e2e-fd-9",
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
  "createdAt": "2026-04-27T11:30:13.312Z",
  "createdBy": "e2e-fd-9",
  "stageContext": "S7"
}
```

### S8 settle CASH

- **Request**: `POST` `/folios/e6c0e1e0-43d4-4be4-be0a-8c2571e13886/settle` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "settlementMethod": "CASH",
    "paymentVerificationRef": "CASH-1777289413368",
    "billingModelConfirmation": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "e6c0e1e0-43d4-4be4-be0a-8c2571e13886",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "state": "SETTLED",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:30:02.708Z",
  "createdBy": "e2e-fd-9",
  "convertedToLiveAt": "2026-04-27T11:30:13.247Z",
  "convertedBy": "e2e-fd-9",
  "closedAt": "2026-04-27T11:30:13.374Z",
  "closedBy": "e2e-fd-9",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": true
}
```

### W9 post-checkout inspection window expired (manual trigger)

- **Request**: `WORKER` `POST_CHECKOUT_INSPECTION_W9` (actor `L1` / `SYSTEM`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
{
  "skipped": false,
  "timerId": "e2640df4-2ce3-4397-b8bc-c10076410ec7"
}
```

### S8->S9 progress-stage

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/progress-stage` (actor `L1` / `e2e-fd-9`)

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
  "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "createdAt": "2026-04-27T11:30:02.557Z",
  "updatedAt": "2026-04-27T11:30:13.447Z",
  "createdBy": "e2e-fd-9",
  "version": 9,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:30:13.240Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-9",
  "registrationCompletedAt": "2026-04-27T11:30:13.240Z",
  "registrationCompletedBy": "e2e-fd-9"
}
```

### S9 list invoices

- **Request**: `GET` `/folios/e6c0e1e0-43d4-4be4-be0a-8c2571e13886/invoices` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
[
  {
    "id": "876ddfed-44e7-44d3-b6ff-35326ab4bac5",
    "folioId": "e6c0e1e0-43d4-4be4-be0a-8c2571e13886",
    "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
    "invoiceType": "PROFORMA",
    "state": "DRAFT",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "proforma-v1",
    "issuedAt": "2026-04-27T11:30:02.711Z",
    "issuedBy": "e2e-fd-9",
    "dispatchedAt": null,
    "dispatchedBy": null,
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "basis": "S3 setup"
    },
    "createdAt": "2026-04-27T11:30:02.712Z"
  }
]
```

### S9 dispatch invoice 876ddfed-44e7-44d3-b6ff-35326ab4bac5

- **Request**: `POST` `/invoices/876ddfed-44e7-44d3-b6ff-35326ab4bac5/dispatch` (actor `L1` / `e2e-fd-9`)

```json
{
  "body": {
    "dispatchedTo": "guest@example.com"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "876ddfed-44e7-44d3-b6ff-35326ab4bac5",
  "folioId": "e6c0e1e0-43d4-4be4-be0a-8c2571e13886",
  "entryId": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "invoiceType": "PROFORMA",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": "proforma-v1",
  "issuedAt": "2026-04-27T11:30:02.711Z",
  "issuedBy": "e2e-fd-9",
  "dispatchedAt": "2026-04-27T11:30:13.458Z",
  "dispatchedBy": "e2e-fd-9",
  "dispatchedTo": "guest@example.com",
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "basis": "S3 setup",
    "dispatchedAt": "2026-04-27T11:30:13.458Z",
    "dispatchedBy": "e2e-fd-9"
  },
  "createdAt": "2026-04-27T11:30:02.712Z"
}
```

### S9 close entry

- **Request**: `POST` `/entries/5f1f945e-6cd4-48da-a160-2bbb5f82d5c7/close` (actor `L2` / `e2e-fom-9`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
{
  "id": "5f1f945e-6cd4-48da-a160-2bbb5f82d5c7",
  "inquiryId": "8b7db71a-8e5e-4437-b602-f837e6511d47",
  "guestProfileId": "22399006-e274-4f9e-a530-0dd9c550f85c",
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
  "createdAt": "2026-04-27T11:30:02.557Z",
  "updatedAt": "2026-04-27T11:30:13.490Z",
  "createdBy": "e2e-fd-9",
  "version": 10,
  "closedAt": "2026-04-27T11:30:13.489Z",
  "closedBy": "e2e-fom-9",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:30:13.240Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-9",
  "registrationCompletedAt": "2026-04-27T11:30:13.240Z",
  "registrationCompletedBy": "e2e-fd-9"
}
```
