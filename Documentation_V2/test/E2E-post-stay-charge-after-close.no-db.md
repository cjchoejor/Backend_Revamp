# E2E post-stay charge after close (S1 → S9 + post-closure charge) — no DB diffs

- **Ran at**: 2026-04-27T11:15:55.792Z
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `0168f693-649e-4970-a2e8-beeb30ae497f`
- **Inquiry ID**: `3de2965a-0915-46ae-918a-07b24b835c63`
- **GuestProfile ID (seeded)**: `99758de0-530b-4f30-871e-c72bf1a36c79`

## Steps

### S1 create inquiry

- **Request**: `POST` `/inquiries` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
    "sourceChannel": "WALK_IN",
    "notes": "e2e post-stay charge after close"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "3de2965a-0915-46ae-918a-07b24b835c63",
  "referenceNumber": "INQ-1777288555879-826908",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
  "agentProfileId": null,
  "sourceChannel": "WALK_IN",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": "e2e post-stay charge after close",
  "createdAt": "2026-04-27T11:15:55.881Z",
  "updatedAt": "2026-04-27T11:15:55.881Z",
  "createdBy": "e2e-fd-7",
  "parkedAt": null,
  "parkedBy": null
}
```

### S1 create entry

- **Request**: `POST` `/entries` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
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
  "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "createdAt": "2026-04-27T11:15:55.899Z",
  "updatedAt": "2026-04-27T11:15:55.899Z",
  "createdBy": "e2e-fd-7",
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

- **Request**: `POST` `/availability/search` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
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
  "configurationId": "3ddc4976-fd4e-4819-90dc-513e1cc4c4c9",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "queriedAt": "2026-04-27T11:15:55.921Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "9c09867b-2900-4e00-8b9a-0b24d21e814c",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "8543dfaa-35a1-43d2-b4e1-cb7baa0bf921",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "8543dfaa-35a1-43d2-b4e1-cb7baa0bf921"
      },
      {
        "inventoryId": "c0947311-80da-4744-9337-056f535e64ec",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "c0947311-80da-4744-9337-056f535e64ec"
      },
      {
        "inventoryId": "d7c5cf0d-5772-4bdc-a643-07b8d20e4926",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "d7c5cf0d-5772-4bdc-a643-07b8d20e4926"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "f7d1ca31-14dd-4ad4-ab93-6b85501c2f32",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "f7d1ca31-14dd-4ad4-ab93-6b85501c2f32"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-27T11:15:55.920Z",
    "isRevalidationRequired": false
  }
}
```

### S1 select availability option

- **Request**: `PATCH` `/availability/configurations/3ddc4976-fd4e-4819-90dc-513e1cc4c4c9/select` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "3ddc4976-fd4e-4819-90dc-513e1cc4c4c9",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
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
        "inventoryId": "9c09867b-2900-4e00-8b9a-0b24d21e814c"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "f7d1ca31-14dd-4ad4-ab93-6b85501c2f32",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-27T11:15:55.920Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "8543dfaa-35a1-43d2-b4e1-cb7baa0bf921",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "c0947311-80da-4744-9337-056f535e64ec",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "d7c5cf0d-5772-4bdc-a643-07b8d20e4926",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T11:15:55.921Z",
  "createdBy": "e2e-fd-7"
}
```

### S1->S2 progress-stage

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/progress-stage` (actor `L1` / `e2e-fd-7`)

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
  "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "createdAt": "2026-04-27T11:15:55.899Z",
  "updatedAt": "2026-04-27T11:15:55.949Z",
  "createdBy": "e2e-fd-7",
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

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/quotations` (actor `L1` / `e2e-fd-7`)

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
  "id": "7d0b4ab9-134f-4f26-8a24-3b74ff916b9c",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "segmentId": "2ba27a05-28a7-4dd2-8b1b-290e96b0161d",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "quote",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "dc9a6f12-8cf5-4ab0-9c3e-3c7ead6d71e5",
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
  "createdAt": "2026-04-27T11:15:55.966Z",
  "createdBy": "e2e-fd-7"
}
```

### S2 send quotation

- **Request**: `POST` `/quotations/7d0b4ab9-134f-4f26-8a24-3b74ff916b9c/send` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "7d0b4ab9-134f-4f26-8a24-3b74ff916b9c",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "segmentId": "2ba27a05-28a7-4dd2-8b1b-290e96b0161d",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "notes": "quote",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "dc9a6f12-8cf5-4ab0-9c3e-3c7ead6d71e5",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T11:15:55.973Z",
  "sentAt": "2026-04-27T11:15:55.973Z",
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T11:15:55.966Z",
  "createdBy": "e2e-fd-7"
}
```

### S2 accept quotation

- **Request**: `POST` `/quotations/7d0b4ab9-134f-4f26-8a24-3b74ff916b9c/accept` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "7d0b4ab9-134f-4f26-8a24-3b74ff916b9c",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "segmentId": "2ba27a05-28a7-4dd2-8b1b-290e96b0161d",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "ACCEPTED",
  "commercialTerms": {
    "notes": "quote",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "dc9a6f12-8cf5-4ab0-9c3e-3c7ead6d71e5",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T11:15:55.973Z",
  "sentAt": "2026-04-27T11:15:55.973Z",
  "sentTo": null,
  "communicationRecordId": "83fd47bc-0699-4d24-bec0-f45ff9b0c61a",
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": "2026-04-27T11:15:56.004Z",
  "acceptedBy": "e2e-fd-7",
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T11:15:55.966Z",
  "createdBy": "e2e-fd-7"
}
```

### S2->S3 progress-stage

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/progress-stage` (actor `L1` / `e2e-fd-7`)

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
  "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "createdAt": "2026-04-27T11:15:55.899Z",
  "updatedAt": "2026-04-27T11:15:56.030Z",
  "createdBy": "e2e-fd-7",
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

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/folio/provisional` (actor `L1` / `e2e-fd-7`)

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
  "id": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:15:56.041Z",
  "createdBy": "e2e-fd-7",
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
      "id": "1f898d27-930a-4d9f-9890-a4f1e7de2fd6",
      "folioId": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
      "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T11:15:56.043Z",
      "issuedBy": "e2e-fd-7",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T11:15:56.044Z"
    }
  ]
}
```

### S3 record advance payment

- **Request**: `POST` `/folios/3e6076f0-cfb7-445b-8479-6d0c6c060289/payments` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
    "amount": 500,
    "notes": "advance"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "11cc86bc-8cf5-451a-a98c-4de9c9fdc8df",
  "folioId": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
  "invoiceId": null,
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "amount": "500",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-27T11:15:56.053Z",
  "receivedAt": "2026-04-27T11:15:56.052Z",
  "recordedBy": "e2e-fd-7",
  "stage": "S3",
  "notes": "advance"
}
```

### S3 reconcile advance payment

- **Request**: `POST` `/folios/3e6076f0-cfb7-445b-8479-6d0c6c060289/advance-payment/reconcile` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
    "note": "reconcile"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:15:56.041Z",
  "createdBy": "e2e-fd-7",
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

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/disclosures/cancellation` (actor `L1` / `e2e-fd-7`)

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
  "id": "9e289d69-8e6c-4ca0-bdcb-19270d6f40fa",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "segmentId": "2ba27a05-28a7-4dd2-8b1b-290e96b0161d",
  "noShowTreatmentStatement": "terms",
  "disclosedTerms": {
    "windowHours": 24
  },
  "disclosedAt": "2026-04-27T11:15:56.065Z",
  "disclosedBy": "e2e-fd-7"
}
```

### S3 committed hold

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/holds/committed` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c",
    "commercialJustification": "hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "060086f0-60e3-43ac-ae1e-d36caeba2bfb",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "segmentId": "2ba27a05-28a7-4dd2-8b1b-290e96b0161d",
  "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c",
  "spaceId": null,
  "roomTypeId": "dc9a6f12-8cf5-4ab0-9c3e-3c7ead6d71e5",
  "state": "PLACED",
  "placedAt": "2026-04-27T11:15:56.079Z",
  "placedBy": "e2e-fd-7",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-27T12:15:56.079Z"
}
```

### S3->S4 confirm reservation

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/confirm` (actor `L1` / `e2e-fd-7`)

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
    "id": "ed42e0a7-a1f5-4ea9-a5e4-aca673032b3b",
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
    "segmentId": "2ba27a05-28a7-4dd2-8b1b-290e96b0161d",
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
    "confirmedAt": "2026-04-27T11:15:56.109Z",
    "confirmedBy": "e2e-fd-7",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-27T11:15:56.110Z"
  },
  "entry": {
    "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
    "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
    "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
    "createdAt": "2026-04-27T11:15:55.899Z",
    "updatedAt": "2026-04-27T11:15:56.125Z",
    "createdBy": "e2e-fd-7",
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
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f"
}
```

### S5 complete pre-arrival task 08e5dffc-6a19-439e-9339-03ac0ceece14

- **Request**: `PATCH` `/pre-arrival-tasks/08e5dffc-6a19-439e-9339-03ac0ceece14` (actor `L1` / `e2e-fd-7`)

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
  "id": "08e5dffc-6a19-439e-9339-03ac0ceece14",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "taskType": "PAYMENT_RECONCILIATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:16:06.439Z",
  "completedBy": "e2e-fd-7",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:16:06.396Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 61dbbfca-81b3-4f0d-b8f6-cafa1d23faf6

- **Request**: `PATCH` `/pre-arrival-tasks/61dbbfca-81b3-4f0d-b8f6-cafa1d23faf6` (actor `L1` / `e2e-fd-7`)

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
  "id": "61dbbfca-81b3-4f0d-b8f6-cafa1d23faf6",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "taskType": "NIGHT_AUDIT_TIMER_REGISTRATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:16:06.445Z",
  "completedBy": "e2e-fd-7",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:16:06.396Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 13205e78-5553-461b-9b95-e540895fde01

- **Request**: `PATCH` `/pre-arrival-tasks/13205e78-5553-461b-9b95-e540895fde01` (actor `L1` / `e2e-fd-7`)

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
  "id": "13205e78-5553-461b-9b95-e540895fde01",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "taskType": "BED_CONFIGURATION_CHANGE",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:16:06.453Z",
  "completedBy": "e2e-fd-7",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:16:06.396Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 41b001fa-7d22-4373-a4b7-da38cb9a25ed

- **Request**: `PATCH` `/pre-arrival-tasks/41b001fa-7d22-4373-a4b7-da38cb9a25ed` (actor `L1` / `e2e-fd-7`)

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
  "id": "41b001fa-7d22-4373-a4b7-da38cb9a25ed",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "taskType": "PRE_ARRIVAL_COMMUNICATION",
  "category": "COMMUNICATION",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:16:06.459Z",
  "completedBy": "e2e-fd-7",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:16:06.396Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 97476ef7-cb74-4b28-af5d-5cac8b380200

- **Request**: `PATCH` `/pre-arrival-tasks/97476ef7-cb74-4b28-af5d-5cac8b380200` (actor `L1` / `e2e-fd-7`)

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
  "id": "97476ef7-cb74-4b28-af5d-5cac8b380200",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "taskType": "SPECIAL_REQUEST_FULFILMENT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:16:06.463Z",
  "completedBy": "e2e-fd-7",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:16:06.396Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 8a0eb399-20be-49ff-a91e-82917407e891

- **Request**: `PATCH` `/pre-arrival-tasks/8a0eb399-20be-49ff-a91e-82917407e891` (actor `L1` / `e2e-fd-7`)

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
  "id": "8a0eb399-20be-49ff-a91e-82917407e891",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "taskType": "LATE_ARRIVAL_MEAL_COORDINATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:16:06.466Z",
  "completedBy": "e2e-fd-7",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:16:06.396Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 500289b5-79ff-413c-b7d1-1bbde295624d

- **Request**: `PATCH` `/pre-arrival-tasks/500289b5-79ff-413c-b7d1-1bbde295624d` (actor `L1` / `e2e-fd-7`)

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
  "id": "500289b5-79ff-413c-b7d1-1bbde295624d",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "taskType": "SITE_VISIT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:16:06.470Z",
  "completedBy": "e2e-fd-7",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:16:06.396Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 9e5e9c92-37b2-4f67-ad4b-3a4497db51f7

- **Request**: `PATCH` `/pre-arrival-tasks/9e5e9c92-37b2-4f67-ad4b-3a4497db51f7` (actor `L1` / `e2e-fd-7`)

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
  "id": "9e5e9c92-37b2-4f67-ad4b-3a4497db51f7",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "taskType": "UNIT_READINESS_VERIFICATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:16:06.474Z",
  "completedBy": "e2e-fd-7",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:16:06.396Z",
  "createdBy": "SYSTEM"
}
```

### S5 room assignment

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/room-assignments` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c",
    "notes": "assign"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "0895c339-bd24-47ff-ad68-fe848d8e5fea",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c",
  "assignedAt": "2026-04-27T11:16:06.483Z",
  "assignedBy": "e2e-fd-7",
  "deficientAtAssignment": false,
  "deficientConditionRecordId": null,
  "acknowledgementActorId": null,
  "acknowledgementAt": null,
  "notes": "assign",
  "createdAt": "2026-04-27T11:16:06.483Z"
}
```

### S5 accept H1

- **Request**: `POST` `/handoffs/8dc19148-a30f-4023-b12d-c0bc8f09fa03/accept` (actor `L1` / `e2e-fd-7`)

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
  "id": "8dc19148-a30f-4023-b12d-c0bc8f09fa03",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "handoffType": "H1",
  "state": "ACCEPTED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-7",
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
  "acceptedAt": "2026-04-27T11:16:06.494Z",
  "acceptedBy": "e2e-fd-7",
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
  "createdAt": "2026-04-27T11:15:56.122Z",
  "createdBy": "e2e-fd-7",
  "stageContext": "S4"
}
```

### S5 fulfil H1

- **Request**: `POST` `/handoffs/8dc19148-a30f-4023-b12d-c0bc8f09fa03/fulfil` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "fulfilmentEvidence": {
      "roomAssignmentId": "0895c339-bd24-47ff-ad68-fe848d8e5fea",
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
  "id": "8dc19148-a30f-4023-b12d-c0bc8f09fa03",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "handoffType": "H1",
  "state": "FULFILLED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-7",
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
    "roomAssignmentId": "0895c339-bd24-47ff-ad68-fe848d8e5fea",
    "readinessConfirmed": true,
    "paymentStatusConfirmed": true,
    "ceilingProximityAddressed": true
  },
  "assignedAt": null,
  "acceptedAt": "2026-04-27T11:16:06.494Z",
  "acceptedBy": "e2e-fd-7",
  "fulfilledAt": "2026-04-27T11:16:06.500Z",
  "fulfilledBy": "e2e-fd-7",
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
  "createdAt": "2026-04-27T11:15:56.122Z",
  "createdBy": "e2e-fd-7",
  "stageContext": "S4"
}
```

### S5->S6 progress-stage

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/progress-stage` (actor `L1` / `e2e-fd-7`)

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
  "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "createdAt": "2026-04-27T11:15:55.899Z",
  "updatedAt": "2026-04-27T11:16:06.518Z",
  "createdBy": "e2e-fd-7",
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

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/handoffs/h2` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "roomNumber": "401",
    "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
    "deficientConditionStatus": null
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "7e161215-159c-4c70-9fff-034cccc23405",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "handoffType": "H2",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-7",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "roomNumber": "401",
    "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "slaDeadlineAt": "2026-04-27T12:16:06.532Z",
  "isAutoFulfilled": false,
  "createdAt": "2026-04-27T11:16:06.534Z",
  "createdBy": "e2e-fd-7",
  "stageContext": "S6"
}
```

### S6 verify guest identity

- **Request**: `POST` `/guest-profiles/99758de0-530b-4f30-871e-c72bf1a36c79/verify-identity` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
    "verificationPath": "FIRST_TIME",
    "documentType": "PASSPORT",
    "documentNumber": "E2E-1777288566541",
    "issuingCountry": "BT"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "identityVerifiedAt": "2026-04-27T11:16:06.547Z",
  "identityVerifiedBy": "e2e-fd-7",
  "identityVerificationPath": "FIRST_TIME",
  "createdAt": "2026-04-27T11:15:54.357Z",
  "updatedAt": "2026-04-27T11:16:06.547Z",
  "createdBy": "actor-seed-system"
}
```

### S6->S7 progress-stage

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/progress-stage` (actor `L1` / `e2e-fd-7`)

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
  "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "createdAt": "2026-04-27T11:15:55.899Z",
  "updatedAt": "2026-04-27T11:16:06.562Z",
  "createdBy": "e2e-fd-7",
  "version": 7,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:16:06.562Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-7",
  "registrationCompletedAt": "2026-04-27T11:16:06.562Z",
  "registrationCompletedBy": "e2e-fd-7",
  "folio": {
    "id": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
    "state": "LIVE",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-27T11:15:56.041Z",
    "createdBy": "e2e-fd-7",
    "convertedToLiveAt": "2026-04-27T11:16:06.571Z",
    "convertedBy": "e2e-fd-7",
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
    "id": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
    "identityVerifiedAt": "2026-04-27T11:16:06.547Z",
    "identityVerifiedBy": "e2e-fd-7",
    "identityVerificationPath": "FIRST_TIME",
    "createdAt": "2026-04-27T11:15:54.357Z",
    "updatedAt": "2026-04-27T11:16:06.547Z",
    "createdBy": "actor-seed-system"
  },
  "handoffs": [
    {
      "id": "a7e9b09c-431a-4912-b3e9-aab9f239c1af",
      "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
      "handoffType": "H3",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-7",
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
        "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
      "slaDeadlineAt": "2026-04-27T12:16:06.562Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:16:06.569Z",
      "createdBy": "e2e-fd-7",
      "stageContext": "S6"
    },
    {
      "id": "7e161215-159c-4c70-9fff-034cccc23405",
      "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
      "handoffType": "H2",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-7",
      "toRole": "HOUSEKEEPING",
      "toActorId": null,
      "checklistContent": {
        "roomNumber": "401",
        "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
      "slaDeadlineAt": "2026-04-27T12:16:06.532Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:16:06.534Z",
      "createdBy": "e2e-fd-7",
      "stageContext": "S6"
    },
    {
      "id": "8dc19148-a30f-4023-b12d-c0bc8f09fa03",
      "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
      "handoffType": "H1",
      "state": "CLOSED",
      "fromRole": "RESERVATIONS",
      "fromActorId": "e2e-fd-7",
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
        "roomAssignmentId": "0895c339-bd24-47ff-ad68-fe848d8e5fea",
        "readinessConfirmed": true,
        "paymentStatusConfirmed": true,
        "ceilingProximityAddressed": true
      },
      "assignedAt": null,
      "acceptedAt": "2026-04-27T11:16:06.494Z",
      "acceptedBy": "e2e-fd-7",
      "fulfilledAt": "2026-04-27T11:16:06.500Z",
      "fulfilledBy": "e2e-fd-7",
      "closedAt": "2026-04-27T11:16:06.562Z",
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": null,
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:15:56.122Z",
      "createdBy": "e2e-fd-7",
      "stageContext": "S4"
    }
  ]
}
```

### S7 run night audit

- **Request**: `POST` `/night-audit/run` (actor `L2` / `e2e-fom-7`)

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
  "id": "9b2d780d-f7ed-4838-be4b-de824eb94bf1",
  "operatingDate": "2026-04-27T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 3,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-27T11:16:06.615Z",
  "createdBy": "e2e-fom-7"
}
```

### S7 initiate H4

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/handoffs/h4` (actor `L1` / `e2e-fd-7`)

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
  "id": "88e5bf0f-c04b-4041-9606-c8122b83125c",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "handoffType": "H4",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-7",
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
  "createdAt": "2026-04-27T11:16:06.630Z",
  "createdBy": "e2e-fd-7",
  "stageContext": "S7"
}
```

### S7->S8 progress-stage

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/progress-stage` (actor `L1` / `e2e-fd-7`)

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
  "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "createdAt": "2026-04-27T11:15:55.899Z",
  "updatedAt": "2026-04-27T11:16:06.645Z",
  "createdBy": "e2e-fd-7",
  "version": 8,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:16:06.562Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-7",
  "registrationCompletedAt": "2026-04-27T11:16:06.562Z",
  "registrationCompletedBy": "e2e-fd-7"
}
```

### S8 key return

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/key-return` (actor `L1` / `e2e-fd-7`)

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
  "id": "cc603cd2-0bf0-4596-b53f-c12ba14436c4",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c",
  "receivedBy": "e2e-fd-7",
  "returnedAt": "2026-04-27T11:16:06.658Z",
  "keyCountIssued": 2,
  "keyCountReturned": 2,
  "countReconciled": true,
  "reconciliationNote": null,
  "createdAt": "2026-04-27T11:16:06.659Z"
}
```

### S8 inspection

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/room-inspection` (actor `L1` / `e2e-fd-7`)

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
  "id": "2114bb8c-73eb-4997-a08e-c915f8a4a952",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "roomId": "9c09867b-2900-4e00-8b9a-0b24d21e814c",
  "segmentId": "2ba27a05-28a7-4dd2-8b1b-290e96b0161d",
  "inspectedBy": "e2e-fd-7",
  "inspectedAt": "2026-04-27T11:16:06.667Z",
  "isDeferred": false,
  "deficientFlagStatus": "NOT_APPLICABLE",
  "deficientConditionId": null,
  "inspectorAssessment": null,
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-04-27T11:16:06.668Z"
}
```

### S8 fulfil H4

- **Request**: `POST` `/handoffs/88e5bf0f-c04b-4041-9606-c8122b83125c/fulfil` (actor `L1` / `e2e-fd-7`)

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
  "id": "88e5bf0f-c04b-4041-9606-c8122b83125c",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "handoffType": "H4",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-7",
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
  "fulfilledAt": "2026-04-27T11:16:06.674Z",
  "fulfilledBy": "e2e-fd-7",
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
  "createdAt": "2026-04-27T11:16:06.630Z",
  "createdBy": "e2e-fd-7",
  "stageContext": "S7"
}
```

### S8 settle CASH

- **Request**: `POST` `/folios/3e6076f0-cfb7-445b-8479-6d0c6c060289/settle` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": {
    "settlementMethod": "CASH",
    "paymentVerificationRef": "CASH-1777288566675",
    "billingModelConfirmation": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "state": "SETTLED",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:15:56.041Z",
  "createdBy": "e2e-fd-7",
  "convertedToLiveAt": "2026-04-27T11:16:06.571Z",
  "convertedBy": "e2e-fd-7",
  "closedAt": "2026-04-27T11:16:06.680Z",
  "closedBy": "e2e-fd-7",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": true
}
```

### S8->S9 progress-stage

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/progress-stage` (actor `L1` / `e2e-fd-7`)

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
  "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "createdAt": "2026-04-27T11:15:55.899Z",
  "updatedAt": "2026-04-27T11:16:06.719Z",
  "createdBy": "e2e-fd-7",
  "version": 9,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:16:06.562Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-7",
  "registrationCompletedAt": "2026-04-27T11:16:06.562Z",
  "registrationCompletedBy": "e2e-fd-7"
}
```

### S9 list invoices

- **Request**: `GET` `/folios/3e6076f0-cfb7-445b-8479-6d0c6c060289/invoices` (actor `L1` / `e2e-fd-7`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
[
  {
    "id": "1f898d27-930a-4d9f-9890-a4f1e7de2fd6",
    "folioId": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
    "invoiceType": "PROFORMA",
    "state": "DRAFT",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "proforma-v1",
    "issuedAt": "2026-04-27T11:15:56.043Z",
    "issuedBy": "e2e-fd-7",
    "dispatchedAt": null,
    "dispatchedBy": null,
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "basis": "S3 setup"
    },
    "createdAt": "2026-04-27T11:15:56.044Z"
  }
]
```

### S9 dispatch invoice 1f898d27-930a-4d9f-9890-a4f1e7de2fd6

- **Request**: `POST` `/invoices/1f898d27-930a-4d9f-9890-a4f1e7de2fd6/dispatch` (actor `L1` / `e2e-fd-7`)

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
  "id": "1f898d27-930a-4d9f-9890-a4f1e7de2fd6",
  "folioId": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
  "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "invoiceType": "PROFORMA",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": "proforma-v1",
  "issuedAt": "2026-04-27T11:15:56.043Z",
  "issuedBy": "e2e-fd-7",
  "dispatchedAt": "2026-04-27T11:16:06.730Z",
  "dispatchedBy": "e2e-fd-7",
  "dispatchedTo": "guest@example.com",
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "basis": "S3 setup",
    "dispatchedAt": "2026-04-27T11:16:06.730Z",
    "dispatchedBy": "e2e-fd-7"
  },
  "createdAt": "2026-04-27T11:15:56.044Z"
}
```

### S9 close entry

- **Request**: `POST` `/entries/0168f693-649e-4970-a2e8-beeb30ae497f/close` (actor `L2` / `e2e-fom-7`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
{
  "id": "0168f693-649e-4970-a2e8-beeb30ae497f",
  "inquiryId": "3de2965a-0915-46ae-918a-07b24b835c63",
  "guestProfileId": "99758de0-530b-4f30-871e-c72bf1a36c79",
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
  "createdAt": "2026-04-27T11:15:55.899Z",
  "updatedAt": "2026-04-27T11:16:06.746Z",
  "createdBy": "e2e-fd-7",
  "version": 10,
  "closedAt": "2026-04-27T11:16:06.745Z",
  "closedBy": "e2e-fom-7",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:16:06.562Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-7",
  "registrationCompletedAt": "2026-04-27T11:16:06.562Z",
  "registrationCompletedBy": "e2e-fd-7"
}
```

### S9 post-stay charge after close

- **Request**: `POST` `/folios/3e6076f0-cfb7-445b-8479-6d0c6c060289/charges` (actor `L2` / `e2e-fom-7`)

```json
{
  "body": {
    "entryId": "0168f693-649e-4970-a2e8-beeb30ae497f",
    "lineType": "OTHER",
    "description": "Minibar after checkout",
    "amount": 30,
    "currency": "BTN",
    "postedAt": "2026-04-29T11:16:06.749Z",
    "isPostStay": true
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "d4722b9a-313a-4df7-95bb-a89764c30df9",
  "folioId": "3e6076f0-cfb7-445b-8479-6d0c6c060289",
  "lineType": "OTHER",
  "description": "Minibar after checkout",
  "amount": "30",
  "currency": "BTN",
  "chargeDate": "2026-04-29T11:16:06.749Z",
  "stage": "S9",
  "postedBy": "e2e-fom-7",
  "nightAuditRecordId": null,
  "isPostStay": true,
  "postedAt": "2026-04-29T11:16:06.749Z",
  "createdAt": "2026-04-27T11:16:06.756Z"
}
```
