# E2E cancellation flow report (S1 → S5 CANCELLED) — no DB diffs

- **Ran at**: 2026-04-27T10:39:11.430Z
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `a347ab52-4a1a-4926-a462-e79d42861297`
- **Inquiry ID**: `2c9692e6-bfbf-4013-989a-ccf89d2763e4`
- **GuestProfile ID (seeded)**: `e6b4370d-ab21-4401-9e87-65a288eaa3fe`

## Steps

### S1 create inquiry

- **Request**: `POST` `/inquiries` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {
    "guestProfileId": "e6b4370d-ab21-4401-9e87-65a288eaa3fe",
    "sourceChannel": "WALK_IN",
    "notes": "e2e cancel flow"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "2c9692e6-bfbf-4013-989a-ccf89d2763e4",
  "referenceNumber": "INQ-1777286351548-595321",
  "guestProfileId": "e6b4370d-ab21-4401-9e87-65a288eaa3fe",
  "agentProfileId": null,
  "sourceChannel": "WALK_IN",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": "e2e cancel flow",
  "createdAt": "2026-04-27T10:39:11.549Z",
  "updatedAt": "2026-04-27T10:39:11.549Z",
  "createdBy": "e2e-fd-5",
  "parkedAt": null,
  "parkedBy": null
}
```

### S1 create entry

- **Request**: `POST` `/entries` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {
    "inquiryId": "2c9692e6-bfbf-4013-989a-ccf89d2763e4",
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
  "id": "a347ab52-4a1a-4926-a462-e79d42861297",
  "inquiryId": "2c9692e6-bfbf-4013-989a-ccf89d2763e4",
  "guestProfileId": "e6b4370d-ab21-4401-9e87-65a288eaa3fe",
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
  "createdAt": "2026-04-27T10:39:11.566Z",
  "updatedAt": "2026-04-27T10:39:11.566Z",
  "createdBy": "e2e-fd-5",
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

- **Request**: `POST` `/availability/search` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {
    "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
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
  "configurationId": "9e73558a-cd9e-4c79-802d-b0ff40c01b08",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "queriedAt": "2026-04-27T10:39:11.590Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "9bf98915-7910-429d-83f1-5395746a4784",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "9bf98915-7910-429d-83f1-5395746a4784"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "d77d988f-6a19-45b3-b18b-23226abf32ea",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "d77d988f-6a19-45b3-b18b-23226abf32ea"
      },
      {
        "inventoryId": "ee2d7846-c621-48e1-99de-9e95c40ec9d0",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "ee2d7846-c621-48e1-99de-9e95c40ec9d0"
      },
      {
        "inventoryId": "fa528531-391d-417b-a17d-48ee52e8a96a",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "fa528531-391d-417b-a17d-48ee52e8a96a"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "11d2c1dc-dfdc-4169-96fe-04fed7e42cb9",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "11d2c1dc-dfdc-4169-96fe-04fed7e42cb9"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-27T10:39:11.589Z",
    "isRevalidationRequired": false
  }
}
```

### S1 select availability option

- **Request**: `PATCH` `/availability/configurations/9e73558a-cd9e-4c79-802d-b0ff40c01b08/select` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {
    "roomId": "9bf98915-7910-429d-83f1-5395746a4784"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "9e73558a-cd9e-4c79-802d-b0ff40c01b08",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
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
        "inventoryId": "9bf98915-7910-429d-83f1-5395746a4784"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "11d2c1dc-dfdc-4169-96fe-04fed7e42cb9",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-27T10:39:11.589Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "d77d988f-6a19-45b3-b18b-23226abf32ea",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "ee2d7846-c621-48e1-99de-9e95c40ec9d0",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "fa528531-391d-417b-a17d-48ee52e8a96a",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "9bf98915-7910-429d-83f1-5395746a4784",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:39:11.590Z",
  "createdBy": "e2e-fd-5"
}
```

### S1->S2 progress-stage

- **Request**: `POST` `/entries/a347ab52-4a1a-4926-a462-e79d42861297/progress-stage` (actor `L1` / `e2e-fd-5`)

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
  "id": "a347ab52-4a1a-4926-a462-e79d42861297",
  "inquiryId": "2c9692e6-bfbf-4013-989a-ccf89d2763e4",
  "guestProfileId": "e6b4370d-ab21-4401-9e87-65a288eaa3fe",
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
  "createdAt": "2026-04-27T10:39:11.566Z",
  "updatedAt": "2026-04-27T10:39:11.630Z",
  "createdBy": "e2e-fd-5",
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

- **Request**: `POST` `/entries/a347ab52-4a1a-4926-a462-e79d42861297/quotations` (actor `L1` / `e2e-fd-5`)

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
  "id": "32f6ca52-f92f-4c5d-99cb-42cf36bb4a83",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "segmentId": "78d8197f-0499-4573-849e-960e2afa12a4",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "0363c739-7ec8-449e-bf68-1a838ecae964",
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
  "createdAt": "2026-04-27T10:39:11.648Z",
  "createdBy": "e2e-fd-5"
}
```

### S2 send quotation

- **Request**: `POST` `/quotations/32f6ca52-f92f-4c5d-99cb-42cf36bb4a83/send` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "32f6ca52-f92f-4c5d-99cb-42cf36bb4a83",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "segmentId": "78d8197f-0499-4573-849e-960e2afa12a4",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "0363c739-7ec8-449e-bf68-1a838ecae964",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T10:39:11.656Z",
  "sentAt": "2026-04-27T10:39:11.656Z",
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:39:11.648Z",
  "createdBy": "e2e-fd-5"
}
```

### S2 accept quotation

- **Request**: `POST` `/quotations/32f6ca52-f92f-4c5d-99cb-42cf36bb4a83/accept` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "32f6ca52-f92f-4c5d-99cb-42cf36bb4a83",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "segmentId": "78d8197f-0499-4573-849e-960e2afa12a4",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "ACCEPTED",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "0363c739-7ec8-449e-bf68-1a838ecae964",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-04-29T10:39:11.656Z",
  "sentAt": "2026-04-27T10:39:11.656Z",
  "sentTo": null,
  "communicationRecordId": "1755530e-7fb0-4c66-a004-4b48b9d16123",
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": "2026-04-27T10:39:11.685Z",
  "acceptedBy": "e2e-fd-5",
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:39:11.648Z",
  "createdBy": "e2e-fd-5"
}
```

### S2->S3 progress-stage

- **Request**: `POST` `/entries/a347ab52-4a1a-4926-a462-e79d42861297/progress-stage` (actor `L1` / `e2e-fd-5`)

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
  "id": "a347ab52-4a1a-4926-a462-e79d42861297",
  "inquiryId": "2c9692e6-bfbf-4013-989a-ccf89d2763e4",
  "guestProfileId": "e6b4370d-ab21-4401-9e87-65a288eaa3fe",
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
  "createdAt": "2026-04-27T10:39:11.566Z",
  "updatedAt": "2026-04-27T10:39:11.711Z",
  "createdBy": "e2e-fd-5",
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

- **Request**: `POST` `/entries/a347ab52-4a1a-4926-a462-e79d42861297/folio/provisional` (actor `L1` / `e2e-fd-5`)

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
  "id": "0c1b5ac6-c263-426a-8fcc-80b79eeb0861",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:39:11.721Z",
  "createdBy": "e2e-fd-5",
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
      "id": "e8710cc2-ff81-4d31-a69b-ccc2cbcc914c",
      "folioId": "0c1b5ac6-c263-426a-8fcc-80b79eeb0861",
      "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T10:39:11.724Z",
      "issuedBy": "e2e-fd-5",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T10:39:11.725Z"
    }
  ]
}
```

### S3 record advance payment

- **Request**: `POST` `/folios/0c1b5ac6-c263-426a-8fcc-80b79eeb0861/payments` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {
    "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
    "amount": 500,
    "notes": "advance for cancellation scenario"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "59f019b7-ed83-4eff-8cf0-1f01e8f1cb36",
  "folioId": "0c1b5ac6-c263-426a-8fcc-80b79eeb0861",
  "invoiceId": null,
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "amount": "500",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-27T10:39:11.742Z",
  "receivedAt": "2026-04-27T10:39:11.741Z",
  "recordedBy": "e2e-fd-5",
  "stage": "S3",
  "notes": "advance for cancellation scenario"
}
```

### S3 reconcile advance payment

- **Request**: `POST` `/folios/0c1b5ac6-c263-426a-8fcc-80b79eeb0861/advance-payment/reconcile` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {
    "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
    "note": "reconcile for cancellation scenario"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "0c1b5ac6-c263-426a-8fcc-80b79eeb0861",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:39:11.721Z",
  "createdBy": "e2e-fd-5",
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

- **Request**: `POST` `/entries/a347ab52-4a1a-4926-a462-e79d42861297/disclosures/cancellation` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {
    "noShowTreatmentStatement": "Standard cancellation disclosure",
    "disclosedTerms": {
      "windowHours": 24
    }
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "9c81e87d-aa10-4ece-ac77-e1a68c2147fe",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "segmentId": "78d8197f-0499-4573-849e-960e2afa12a4",
  "noShowTreatmentStatement": "Standard cancellation disclosure",
  "disclosedTerms": {
    "windowHours": 24
  },
  "disclosedAt": "2026-04-27T10:39:11.759Z",
  "disclosedBy": "e2e-fd-5"
}
```

### S3 committed hold

- **Request**: `POST` `/entries/a347ab52-4a1a-4926-a462-e79d42861297/holds/committed` (actor `L1` / `e2e-fd-5`)

```json
{
  "body": {
    "roomId": "9bf98915-7910-429d-83f1-5395746a4784",
    "commercialJustification": "Cancellation scenario hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "27273632-8dbc-49c7-a01a-04439a82cd8c",
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
  "segmentId": "78d8197f-0499-4573-849e-960e2afa12a4",
  "roomId": "9bf98915-7910-429d-83f1-5395746a4784",
  "spaceId": null,
  "roomTypeId": "0363c739-7ec8-449e-bf68-1a838ecae964",
  "state": "PLACED",
  "placedAt": "2026-04-27T10:39:11.781Z",
  "placedBy": "e2e-fd-5",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "Cancellation scenario hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-27T11:39:11.781Z"
}
```

### S3->S4 confirm reservation

- **Request**: `POST` `/entries/a347ab52-4a1a-4926-a462-e79d42861297/confirm` (actor `L1` / `e2e-fd-5`)

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
    "id": "30dc9027-f127-420a-88f3-d5863ce35309",
    "entryId": "a347ab52-4a1a-4926-a462-e79d42861297",
    "segmentId": "78d8197f-0499-4573-849e-960e2afa12a4",
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
    "confirmedAt": "2026-04-27T10:39:11.815Z",
    "confirmedBy": "e2e-fd-5",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-27T10:39:11.816Z"
  },
  "entry": {
    "id": "a347ab52-4a1a-4926-a462-e79d42861297",
    "inquiryId": "2c9692e6-bfbf-4013-989a-ccf89d2763e4",
    "guestProfileId": "e6b4370d-ab21-4401-9e87-65a288eaa3fe",
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
    "createdAt": "2026-04-27T10:39:11.566Z",
    "updatedAt": "2026-04-27T10:39:11.830Z",
    "createdBy": "e2e-fd-5",
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
  "entryId": "a347ab52-4a1a-4926-a462-e79d42861297"
}
```

### S5 cancel entry

- **Request**: `POST` `/entries/a347ab52-4a1a-4926-a462-e79d42861297/cancel` (actor `L2` / `e2e-fom-5`)

```json
{
  "body": {}
}
```

- **Response**: HTTP 200

```json
{
  "id": "a347ab52-4a1a-4926-a462-e79d42861297",
  "inquiryId": "2c9692e6-bfbf-4013-989a-ccf89d2763e4",
  "guestProfileId": "e6b4370d-ab21-4401-9e87-65a288eaa3fe",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "CANCELLED",
  "currentStage": "S5",
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
  "createdAt": "2026-04-27T10:39:11.566Z",
  "updatedAt": "2026-04-27T10:39:22.041Z",
  "createdBy": "e2e-fd-5",
  "version": 6,
  "closedAt": "2026-04-27T10:39:22.040Z",
  "closedBy": "e2e-fom-5",
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
