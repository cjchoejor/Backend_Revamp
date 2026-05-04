# E2E voucher flow report (S1 → S9) — no DB diffs

- **Ran at**: 2026-04-27T10:10:50.933Z
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `de712465-3f84-467b-a3b7-dc68fe97feb4`
- **Inquiry ID**: `69c7c7c1-0636-4ac8-b549-5d922d51137a`
- **GuestProfile ID (seeded)**: `812fbd7a-2693-4a67-af23-6d315bbdef80`

## Steps

### S1 create inquiry

- **Request**: `POST` `/inquiries` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
    "sourceChannel": "WALK_IN",
    "notes": "e2e voucher flow"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "referenceNumber": "INQ-1777284651017-477427",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
  "agentProfileId": null,
  "sourceChannel": "WALK_IN",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": "e2e voucher flow",
  "createdAt": "2026-04-27T10:10:51.018Z",
  "updatedAt": "2026-04-27T10:10:51.018Z",
  "createdBy": "e2e-fd-3",
  "parkedAt": null,
  "parkedBy": null
}
```

### S1 create entry

- **Request**: `POST` `/entries` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
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
  "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "createdAt": "2026-04-27T10:10:51.037Z",
  "updatedAt": "2026-04-27T10:10:51.037Z",
  "createdBy": "e2e-fd-3",
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

- **Request**: `POST` `/availability/search` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
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
  "configurationId": "6d0af195-f779-4405-a27e-c90d7cddd90d",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "queriedAt": "2026-04-27T10:10:51.050Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "543cedc6-de06-4aae-94c3-86958649373a",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "543cedc6-de06-4aae-94c3-86958649373a"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "cb19c487-a19b-4849-926f-e1ba4953ea33",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "cb19c487-a19b-4849-926f-e1ba4953ea33"
      },
      {
        "inventoryId": "2e0e735f-05b8-4fe6-842a-eb0202937284",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "2e0e735f-05b8-4fe6-842a-eb0202937284"
      },
      {
        "inventoryId": "e0ef62de-20fa-4511-9570-c744f6b79c6c",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "e0ef62de-20fa-4511-9570-c744f6b79c6c"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "85aa2224-98fa-4eb2-a248-a1a685bb65fd",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "85aa2224-98fa-4eb2-a248-a1a685bb65fd"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-27T10:10:51.049Z",
    "isRevalidationRequired": false
  }
}
```

### S1 select availability option

- **Request**: `PATCH` `/availability/configurations/6d0af195-f779-4405-a27e-c90d7cddd90d/select` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "roomId": "543cedc6-de06-4aae-94c3-86958649373a"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "6d0af195-f779-4405-a27e-c90d7cddd90d",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
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
        "inventoryId": "543cedc6-de06-4aae-94c3-86958649373a"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "85aa2224-98fa-4eb2-a248-a1a685bb65fd",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-27T10:10:51.049Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "cb19c487-a19b-4849-926f-e1ba4953ea33",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "2e0e735f-05b8-4fe6-842a-eb0202937284",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "e0ef62de-20fa-4511-9570-c744f6b79c6c",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "543cedc6-de06-4aae-94c3-86958649373a",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:10:51.050Z",
  "createdBy": "e2e-fd-3"
}
```

### S1->S2 progress-stage

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/progress-stage` (actor `L1` / `e2e-fd-3`)

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
  "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "createdAt": "2026-04-27T10:10:51.037Z",
  "updatedAt": "2026-04-27T10:10:51.075Z",
  "createdBy": "e2e-fd-3",
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

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/quotations` (actor `L1` / `e2e-fd-3`)

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
  "id": "28e459e3-676c-479b-b95e-3b35a99f39a1",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "segmentId": "93dc52a1-4b28-4477-ae2b-d299bcfc2a84",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "359f4603-4b2f-49fe-a1c2-9fc9a29d0bf9",
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
  "createdAt": "2026-04-27T10:10:51.088Z",
  "createdBy": "e2e-fd-3"
}
```

### S2 send quotation

- **Request**: `POST` `/quotations/28e459e3-676c-479b-b95e-3b35a99f39a1/send` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "28e459e3-676c-479b-b95e-3b35a99f39a1",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "segmentId": "93dc52a1-4b28-4477-ae2b-d299bcfc2a84",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "359f4603-4b2f-49fe-a1c2-9fc9a29d0bf9",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T10:10:51.094Z",
  "sentAt": "2026-04-27T10:10:51.094Z",
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:10:51.088Z",
  "createdBy": "e2e-fd-3"
}
```

### S2 accept quotation

- **Request**: `POST` `/quotations/28e459e3-676c-479b-b95e-3b35a99f39a1/accept` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "28e459e3-676c-479b-b95e-3b35a99f39a1",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "segmentId": "93dc52a1-4b28-4477-ae2b-d299bcfc2a84",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "ACCEPTED",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "359f4603-4b2f-49fe-a1c2-9fc9a29d0bf9",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T10:10:51.094Z",
  "sentAt": "2026-04-27T10:10:51.094Z",
  "sentTo": null,
  "communicationRecordId": "a94f6079-50ea-4e50-b044-aa66e7cbbd61",
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": "2026-04-27T10:10:51.121Z",
  "acceptedBy": "e2e-fd-3",
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:10:51.088Z",
  "createdBy": "e2e-fd-3"
}
```

### S2->S3 progress-stage

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/progress-stage` (actor `L1` / `e2e-fd-3`)

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
  "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "createdAt": "2026-04-27T10:10:51.037Z",
  "updatedAt": "2026-04-27T10:10:51.143Z",
  "createdBy": "e2e-fd-3",
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

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/folio/provisional` (actor `L1` / `e2e-fd-3`)

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
  "id": "cf389fde-4232-4676-9d0a-385cb0775c04",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:10:51.152Z",
  "createdBy": "e2e-fd-3",
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
      "id": "de127dec-737a-4111-aa35-fb95b7aa5729",
      "folioId": "cf389fde-4232-4676-9d0a-385cb0775c04",
      "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T10:10:51.154Z",
      "issuedBy": "e2e-fd-3",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T10:10:51.155Z"
    }
  ]
}
```

### S3 record advance payment

- **Request**: `POST` `/folios/cf389fde-4232-4676-9d0a-385cb0775c04/payments` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "amount": 1000,
    "notes": "e2e advance payment"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "764f82bb-9b86-447d-9e58-3d6b84d94643",
  "folioId": "cf389fde-4232-4676-9d0a-385cb0775c04",
  "invoiceId": null,
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "amount": "1000",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-27T10:10:51.168Z",
  "receivedAt": "2026-04-27T10:10:51.167Z",
  "recordedBy": "e2e-fd-3",
  "stage": "S3",
  "notes": "e2e advance payment"
}
```

### S3 reconcile advance payment

- **Request**: `POST` `/folios/cf389fde-4232-4676-9d0a-385cb0775c04/advance-payment/reconcile` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "note": "e2e reconcile"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "cf389fde-4232-4676-9d0a-385cb0775c04",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:10:51.152Z",
  "createdBy": "e2e-fd-3",
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

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/disclosures/cancellation` (actor `L1` / `e2e-fd-3`)

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
  "id": "b356e2d8-c4a7-4f9e-ad6f-bf283c139207",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "segmentId": "93dc52a1-4b28-4477-ae2b-d299bcfc2a84",
  "noShowTreatmentStatement": "Standard no-show policy",
  "disclosedTerms": {
    "windowHours": 24
  },
  "disclosedAt": "2026-04-27T10:10:51.179Z",
  "disclosedBy": "e2e-fd-3"
}
```

### S3 committed hold

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/holds/committed` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "roomId": "543cedc6-de06-4aae-94c3-86958649373a",
    "commercialJustification": "Voucher scenario hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "2d391dca-5164-4144-a7e6-93afd0222310",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "segmentId": "93dc52a1-4b28-4477-ae2b-d299bcfc2a84",
  "roomId": "543cedc6-de06-4aae-94c3-86958649373a",
  "spaceId": null,
  "roomTypeId": "359f4603-4b2f-49fe-a1c2-9fc9a29d0bf9",
  "state": "PLACED",
  "placedAt": "2026-04-27T10:10:51.195Z",
  "placedBy": "e2e-fd-3",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "Voucher scenario hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-27T11:10:51.195Z"
}
```

### S3->S4 confirm reservation

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/confirm` (actor `L1` / `e2e-fd-3`)

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
    "id": "ede9ded6-d085-4c1a-95e3-9ffdd34ca21e",
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "segmentId": "93dc52a1-4b28-4477-ae2b-d299bcfc2a84",
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
    "confirmedAt": "2026-04-27T10:10:51.227Z",
    "confirmedBy": "e2e-fd-3",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-27T10:10:51.228Z"
  },
  "entry": {
    "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
    "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
    "createdAt": "2026-04-27T10:10:51.037Z",
    "updatedAt": "2026-04-27T10:10:51.241Z",
    "createdBy": "e2e-fd-3",
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
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4"
}
```

### S5 complete pre-arrival task 29e5674f-8411-4bb4-ac10-a3f2f8e50cef

- **Request**: `PATCH` `/pre-arrival-tasks/29e5674f-8411-4bb4-ac10-a3f2f8e50cef` (actor `L1` / `e2e-fd-3`)

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
  "id": "29e5674f-8411-4bb4-ac10-a3f2f8e50cef",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "taskType": "PAYMENT_RECONCILIATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T10:11:01.480Z",
  "completedBy": "e2e-fd-3",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T10:11:01.430Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 94e48db5-0c2a-47d5-a0b9-296f1ae6d94a

- **Request**: `PATCH` `/pre-arrival-tasks/94e48db5-0c2a-47d5-a0b9-296f1ae6d94a` (actor `L1` / `e2e-fd-3`)

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
  "id": "94e48db5-0c2a-47d5-a0b9-296f1ae6d94a",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "taskType": "NIGHT_AUDIT_TIMER_REGISTRATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T10:11:01.484Z",
  "completedBy": "e2e-fd-3",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T10:11:01.430Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task d195995b-fb66-4a02-a5ec-a2ecb439ca61

- **Request**: `PATCH` `/pre-arrival-tasks/d195995b-fb66-4a02-a5ec-a2ecb439ca61` (actor `L1` / `e2e-fd-3`)

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
  "id": "d195995b-fb66-4a02-a5ec-a2ecb439ca61",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "taskType": "BED_CONFIGURATION_CHANGE",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T10:11:01.488Z",
  "completedBy": "e2e-fd-3",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T10:11:01.430Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 09e23b78-bf5b-49fc-9ab4-895df73bae6d

- **Request**: `PATCH` `/pre-arrival-tasks/09e23b78-bf5b-49fc-9ab4-895df73bae6d` (actor `L1` / `e2e-fd-3`)

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
  "id": "09e23b78-bf5b-49fc-9ab4-895df73bae6d",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "taskType": "PRE_ARRIVAL_COMMUNICATION",
  "category": "COMMUNICATION",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T10:11:01.491Z",
  "completedBy": "e2e-fd-3",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T10:11:01.430Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 169c5bc2-ce59-4066-832d-10ad010a9026

- **Request**: `PATCH` `/pre-arrival-tasks/169c5bc2-ce59-4066-832d-10ad010a9026` (actor `L1` / `e2e-fd-3`)

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
  "id": "169c5bc2-ce59-4066-832d-10ad010a9026",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "taskType": "SPECIAL_REQUEST_FULFILMENT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T10:11:01.494Z",
  "completedBy": "e2e-fd-3",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T10:11:01.430Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task d3bec406-b436-4de4-8f24-b5974de23ba5

- **Request**: `PATCH` `/pre-arrival-tasks/d3bec406-b436-4de4-8f24-b5974de23ba5` (actor `L1` / `e2e-fd-3`)

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
  "id": "d3bec406-b436-4de4-8f24-b5974de23ba5",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "taskType": "LATE_ARRIVAL_MEAL_COORDINATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T10:11:01.497Z",
  "completedBy": "e2e-fd-3",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T10:11:01.430Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task 4d1cdeb1-9a1a-4944-b965-31899c886a52

- **Request**: `PATCH` `/pre-arrival-tasks/4d1cdeb1-9a1a-4944-b965-31899c886a52` (actor `L1` / `e2e-fd-3`)

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
  "id": "4d1cdeb1-9a1a-4944-b965-31899c886a52",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "taskType": "SITE_VISIT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T10:11:01.501Z",
  "completedBy": "e2e-fd-3",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T10:11:01.430Z",
  "createdBy": "SYSTEM"
}
```

### S5 complete pre-arrival task ec42b9e6-9759-4ab2-8b47-186c71416f9a

- **Request**: `PATCH` `/pre-arrival-tasks/ec42b9e6-9759-4ab2-8b47-186c71416f9a` (actor `L1` / `e2e-fd-3`)

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
  "id": "ec42b9e6-9759-4ab2-8b47-186c71416f9a",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "taskType": "UNIT_READINESS_VERIFICATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T10:11:01.506Z",
  "completedBy": "e2e-fd-3",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T10:11:01.430Z",
  "createdBy": "SYSTEM"
}
```

### S5 room assignment

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/room-assignments` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "roomId": "543cedc6-de06-4aae-94c3-86958649373a",
    "notes": "e2e assign"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "7bb152b1-8235-46a5-8d8e-b781fcdda96d",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "roomId": "543cedc6-de06-4aae-94c3-86958649373a",
  "assignedAt": "2026-04-27T10:11:01.516Z",
  "assignedBy": "e2e-fd-3",
  "deficientAtAssignment": false,
  "deficientConditionRecordId": null,
  "acknowledgementActorId": null,
  "acknowledgementAt": null,
  "notes": "e2e assign",
  "createdAt": "2026-04-27T10:11:01.516Z"
}
```

### S5 accept H1

- **Request**: `POST` `/handoffs/948b36a4-fed7-4383-87bc-877313adb574/accept` (actor `L1` / `e2e-fd-3`)

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
  "id": "948b36a4-fed7-4383-87bc-877313adb574",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "handoffType": "H1",
  "state": "ACCEPTED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-3",
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
  "acceptedAt": "2026-04-27T10:11:01.530Z",
  "acceptedBy": "e2e-fd-3",
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
  "createdAt": "2026-04-27T10:10:51.238Z",
  "createdBy": "e2e-fd-3",
  "stageContext": "S4"
}
```

### S5 fulfil H1

- **Request**: `POST` `/handoffs/948b36a4-fed7-4383-87bc-877313adb574/fulfil` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "fulfilmentEvidence": {
      "roomAssignmentId": "7bb152b1-8235-46a5-8d8e-b781fcdda96d",
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
  "id": "948b36a4-fed7-4383-87bc-877313adb574",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "handoffType": "H1",
  "state": "FULFILLED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-3",
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
    "roomAssignmentId": "7bb152b1-8235-46a5-8d8e-b781fcdda96d",
    "readinessConfirmed": true,
    "paymentStatusConfirmed": true,
    "ceilingProximityAddressed": true
  },
  "assignedAt": null,
  "acceptedAt": "2026-04-27T10:11:01.530Z",
  "acceptedBy": "e2e-fd-3",
  "fulfilledAt": "2026-04-27T10:11:01.535Z",
  "fulfilledBy": "e2e-fd-3",
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
  "createdAt": "2026-04-27T10:10:51.238Z",
  "createdBy": "e2e-fd-3",
  "stageContext": "S4"
}
```

### S5->S6 progress-stage (guest present)

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/progress-stage` (actor `L1` / `e2e-fd-3`)

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
  "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "createdAt": "2026-04-27T10:10:51.037Z",
  "updatedAt": "2026-04-27T10:11:01.550Z",
  "createdBy": "e2e-fd-3",
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

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/handoffs/h2` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "roomNumber": "401",
    "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
    "deficientConditionStatus": null
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "e24fbe0c-80cb-4149-8c91-95cd753e2703",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "handoffType": "H2",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-3",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "roomNumber": "401",
    "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "slaDeadlineAt": "2026-04-27T11:11:01.567Z",
  "isAutoFulfilled": false,
  "createdAt": "2026-04-27T10:11:01.568Z",
  "createdBy": "e2e-fd-3",
  "stageContext": "S6"
}
```

### S6 verify guest identity

- **Request**: `POST` `/guest-profiles/812fbd7a-2693-4a67-af23-6d315bbdef80/verify-identity` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "verificationPath": "FIRST_TIME",
    "documentType": "PASSPORT",
    "documentNumber": "E2E-1777284661575",
    "issuingCountry": "BT"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "identityVerifiedAt": "2026-04-27T10:11:01.583Z",
  "identityVerifiedBy": "e2e-fd-3",
  "identityVerificationPath": "FIRST_TIME",
  "createdAt": "2026-04-27T10:10:49.408Z",
  "updatedAt": "2026-04-27T10:11:01.583Z",
  "createdBy": "actor-seed-system"
}
```

### S6->S7 progress-stage (complete check-in)

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/progress-stage` (actor `L1` / `e2e-fd-3`)

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
  "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "createdAt": "2026-04-27T10:10:51.037Z",
  "updatedAt": "2026-04-27T10:11:01.607Z",
  "createdBy": "e2e-fd-3",
  "version": 7,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T10:11:01.607Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-3",
  "registrationCompletedAt": "2026-04-27T10:11:01.607Z",
  "registrationCompletedBy": "e2e-fd-3",
  "folio": {
    "id": "cf389fde-4232-4676-9d0a-385cb0775c04",
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "state": "LIVE",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-27T10:10:51.152Z",
    "createdBy": "e2e-fd-3",
    "convertedToLiveAt": "2026-04-27T10:11:01.614Z",
    "convertedBy": "e2e-fd-3",
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
    "id": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
    "identityVerifiedAt": "2026-04-27T10:11:01.583Z",
    "identityVerifiedBy": "e2e-fd-3",
    "identityVerificationPath": "FIRST_TIME",
    "createdAt": "2026-04-27T10:10:49.408Z",
    "updatedAt": "2026-04-27T10:11:01.583Z",
    "createdBy": "actor-seed-system"
  },
  "handoffs": [
    {
      "id": "e69312aa-c5ee-4bd9-86af-3f48254c4e7a",
      "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
      "handoffType": "H3",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-3",
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
        "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
      "slaDeadlineAt": "2026-04-27T11:11:01.607Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T10:11:01.612Z",
      "createdBy": "e2e-fd-3",
      "stageContext": "S6"
    },
    {
      "id": "e24fbe0c-80cb-4149-8c91-95cd753e2703",
      "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
      "handoffType": "H2",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-3",
      "toRole": "HOUSEKEEPING",
      "toActorId": null,
      "checklistContent": {
        "roomNumber": "401",
        "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
      "slaDeadlineAt": "2026-04-27T11:11:01.567Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T10:11:01.568Z",
      "createdBy": "e2e-fd-3",
      "stageContext": "S6"
    },
    {
      "id": "948b36a4-fed7-4383-87bc-877313adb574",
      "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
      "handoffType": "H1",
      "state": "CLOSED",
      "fromRole": "RESERVATIONS",
      "fromActorId": "e2e-fd-3",
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
        "roomAssignmentId": "7bb152b1-8235-46a5-8d8e-b781fcdda96d",
        "readinessConfirmed": true,
        "paymentStatusConfirmed": true,
        "ceilingProximityAddressed": true
      },
      "assignedAt": null,
      "acceptedAt": "2026-04-27T10:11:01.530Z",
      "acceptedBy": "e2e-fd-3",
      "fulfilledAt": "2026-04-27T10:11:01.535Z",
      "fulfilledBy": "e2e-fd-3",
      "closedAt": "2026-04-27T10:11:01.607Z",
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": null,
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T10:10:51.238Z",
      "createdBy": "e2e-fd-3",
      "stageContext": "S4"
    }
  ]
}
```

### S7 post an extra charge (room service)

- **Request**: `POST` `/folios/cf389fde-4232-4676-9d0a-385cb0775c04/charges` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "lineType": "F_AND_B",
    "description": "Room service",
    "amount": 120,
    "chargeDate": "2026-04-27T10:11:01.643Z"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "cb2c44b5-35ff-4089-965f-4d5933739ba3",
  "folioId": "cf389fde-4232-4676-9d0a-385cb0775c04",
  "lineType": "F_AND_B",
  "description": "Room service",
  "amount": "120",
  "currency": "BTN",
  "chargeDate": "2026-04-27T10:11:01.643Z",
  "stage": "S7",
  "postedBy": "e2e-fd-3",
  "nightAuditRecordId": null,
  "isPostStay": false,
  "postedAt": "2026-04-27T10:11:01.660Z",
  "createdAt": "2026-04-27T10:11:01.660Z"
}
```

### S7 run night audit (last operating date)

- **Request**: `POST` `/night-audit/run` (actor `L2` / `e2e-fom-3`)

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
  "id": "abcaecfe-73fa-4a48-afbf-7b6cff073470",
  "operatingDate": "2026-04-27T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 3,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-27T10:11:01.685Z",
  "createdBy": "e2e-fom-3"
}
```

### S7 initiate H4

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/handoffs/h4` (actor `L1` / `e2e-fd-3`)

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
  "id": "05ff18e5-63fb-4106-9c41-351dcdbccc55",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "handoffType": "H4",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-3",
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
  "createdAt": "2026-04-27T10:11:01.706Z",
  "createdBy": "e2e-fd-3",
  "stageContext": "S7"
}
```

### S7->S8 progress-stage (stay exit)

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/progress-stage` (actor `L1` / `e2e-fd-3`)

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
  "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "createdAt": "2026-04-27T10:10:51.037Z",
  "updatedAt": "2026-04-27T10:11:01.729Z",
  "createdBy": "e2e-fd-3",
  "version": 8,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T10:11:01.607Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-3",
  "registrationCompletedAt": "2026-04-27T10:11:01.607Z",
  "registrationCompletedBy": "e2e-fd-3"
}
```

### S8 record key return

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/key-return` (actor `L1` / `e2e-fd-3`)

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
  "id": "3f7d0100-b1d0-4bca-a66c-1ad1015f4061",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "roomId": "543cedc6-de06-4aae-94c3-86958649373a",
  "receivedBy": "e2e-fd-3",
  "returnedAt": "2026-04-27T10:11:01.751Z",
  "keyCountIssued": 2,
  "keyCountReturned": 2,
  "countReconciled": true,
  "reconciliationNote": null,
  "createdAt": "2026-04-27T10:11:01.752Z"
}
```

### S8 record room inspection

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/room-inspection` (actor `L1` / `e2e-fd-3`)

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
  "id": "a4a5f080-774c-4e8b-b76f-fa6a7e337c84",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "roomId": "543cedc6-de06-4aae-94c3-86958649373a",
  "segmentId": "93dc52a1-4b28-4477-ae2b-d299bcfc2a84",
  "inspectedBy": "e2e-fd-3",
  "inspectedAt": "2026-04-27T10:11:01.763Z",
  "isDeferred": false,
  "deficientFlagStatus": "NOT_APPLICABLE",
  "deficientConditionId": null,
  "inspectorAssessment": null,
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-04-27T10:11:01.764Z"
}
```

### S8 fulfil H4

- **Request**: `POST` `/handoffs/05ff18e5-63fb-4106-9c41-351dcdbccc55/fulfil` (actor `L1` / `e2e-fd-3`)

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
  "id": "05ff18e5-63fb-4106-9c41-351dcdbccc55",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "handoffType": "H4",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-3",
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
  "fulfilledAt": "2026-04-27T10:11:01.773Z",
  "fulfilledBy": "e2e-fd-3",
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
  "createdAt": "2026-04-27T10:11:01.706Z",
  "createdBy": "e2e-fd-3",
  "stageContext": "S7"
}
```

### S8 get folio

- **Request**: `GET` `/folios/cf389fde-4232-4676-9d0a-385cb0775c04` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
{
  "id": "cf389fde-4232-4676-9d0a-385cb0775c04",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "state": "LIVE",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:10:51.152Z",
  "createdBy": "e2e-fd-3",
  "convertedToLiveAt": "2026-04-27T10:11:01.614Z",
  "convertedBy": "e2e-fd-3",
  "closedAt": null,
  "closedBy": null,
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "620",
  "advancePaymentReconciliationComplete": true
}
```

### S8 settle folio (VOUCHER partial => OUTSTANDING)

- **Request**: `POST` `/folios/cf389fde-4232-4676-9d0a-385cb0775c04/settle` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "settlementMethod": "VOUCHER",
    "voucherAmount": 610,
    "billingModelConfirmation": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "cf389fde-4232-4676-9d0a-385cb0775c04",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "state": "OUTSTANDING",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:10:51.152Z",
  "createdBy": "e2e-fd-3",
  "convertedToLiveAt": "2026-04-27T10:11:01.614Z",
  "convertedBy": "e2e-fd-3",
  "closedAt": "2026-04-27T10:11:01.787Z",
  "closedBy": "e2e-fd-3",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "10",
  "advancePaymentReconciliationComplete": true
}
```

### S8->S9 progress-stage (closure stage)

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/progress-stage` (actor `L1` / `e2e-fd-3`)

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
  "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "createdAt": "2026-04-27T10:10:51.037Z",
  "updatedAt": "2026-04-27T10:11:01.821Z",
  "createdBy": "e2e-fd-3",
  "version": 9,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T10:11:01.607Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-3",
  "registrationCompletedAt": "2026-04-27T10:11:01.607Z",
  "registrationCompletedBy": "e2e-fd-3"
}
```

### S9 fulfil H5

- **Request**: `POST` `/handoffs/0415875c-8460-489f-896c-98810c9eda0e/fulfil` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "fulfilmentEvidence": {
      "resolutionBasis": "VOUCHER_AND_AGENT_BILLING"
    }
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "0415875c-8460-489f-896c-98810c9eda0e",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "handoffType": "H5",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-3",
  "toRole": "FINANCE",
  "toActorId": null,
  "checklistContent": {
    "basis": "Checkout governed outstanding",
    "outstandingBalance": "10"
  },
  "deficientConditionStatus": null,
  "fulfilmentEvidence": {
    "resolutionBasis": "VOUCHER_AND_AGENT_BILLING"
  },
  "assignedAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "fulfilledAt": "2026-04-27T10:11:01.833Z",
  "fulfilledBy": "e2e-fd-3",
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
  "createdAt": "2026-04-27T10:11:01.820Z",
  "createdBy": "e2e-fd-3",
  "stageContext": "S8"
}
```

### S9 list invoices

- **Request**: `GET` `/folios/cf389fde-4232-4676-9d0a-385cb0775c04/invoices` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
[
  {
    "id": "a37e0055-9dba-45de-9d16-dd198a54bdb6",
    "folioId": "cf389fde-4232-4676-9d0a-385cb0775c04",
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "invoiceType": "FINAL",
    "state": "DISPATCHED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "agent-billing-v1",
    "issuedAt": "2026-04-27T10:11:01.785Z",
    "issuedBy": "e2e-fd-3",
    "dispatchedAt": "2026-04-27T10:11:01.785Z",
    "dispatchedBy": "e2e-fd-3",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "remaining": 10,
      "billingModel": "GUEST_PAY",
      "voucherCovered": 610,
      "settlementMethod": "VOUCHER"
    },
    "createdAt": "2026-04-27T10:11:01.786Z"
  },
  {
    "id": "de127dec-737a-4111-aa35-fb95b7aa5729",
    "folioId": "cf389fde-4232-4676-9d0a-385cb0775c04",
    "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
    "invoiceType": "PROFORMA",
    "state": "DRAFT",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "proforma-v1",
    "issuedAt": "2026-04-27T10:10:51.154Z",
    "issuedBy": "e2e-fd-3",
    "dispatchedAt": null,
    "dispatchedBy": null,
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "basis": "S3 setup"
    },
    "createdAt": "2026-04-27T10:10:51.155Z"
  }
]
```

### S9 dispatch invoice de127dec-737a-4111-aa35-fb95b7aa5729

- **Request**: `POST` `/invoices/de127dec-737a-4111-aa35-fb95b7aa5729/dispatch` (actor `L1` / `e2e-fd-3`)

```json
{
  "body": {
    "dispatchedTo": "agent@example.com"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "de127dec-737a-4111-aa35-fb95b7aa5729",
  "folioId": "cf389fde-4232-4676-9d0a-385cb0775c04",
  "entryId": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "invoiceType": "PROFORMA",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": "proforma-v1",
  "issuedAt": "2026-04-27T10:10:51.154Z",
  "issuedBy": "e2e-fd-3",
  "dispatchedAt": "2026-04-27T10:11:01.842Z",
  "dispatchedBy": "e2e-fd-3",
  "dispatchedTo": "agent@example.com",
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "basis": "S3 setup",
    "dispatchedAt": "2026-04-27T10:11:01.842Z",
    "dispatchedBy": "e2e-fd-3"
  },
  "createdAt": "2026-04-27T10:10:51.155Z"
}
```

### S9 close entry

- **Request**: `POST` `/entries/de712465-3f84-467b-a3b7-dc68fe97feb4/close` (actor `L2` / `e2e-fom-3`)

```json
{
  "body": null
}
```

- **Response**: HTTP 200

```json
{
  "id": "de712465-3f84-467b-a3b7-dc68fe97feb4",
  "inquiryId": "69c7c7c1-0636-4ac8-b549-5d922d51137a",
  "guestProfileId": "812fbd7a-2693-4a67-af23-6d315bbdef80",
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
  "createdAt": "2026-04-27T10:10:51.037Z",
  "updatedAt": "2026-04-27T10:11:01.872Z",
  "createdBy": "e2e-fd-3",
  "version": 10,
  "closedAt": "2026-04-27T10:11:01.871Z",
  "closedBy": "e2e-fom-3",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T10:11:01.607Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-3",
  "registrationCompletedAt": "2026-04-27T10:11:01.607Z",
  "registrationCompletedBy": "e2e-fd-3"
}
```
