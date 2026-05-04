# Boss summary report

- **Source report**: `Documentation_V2/test/E2E-basic-s1-to-s9-test-report.no-db.md`
- **Scenario title**: E2E basic flow report (S1 → S9)
- **Goal**: Validate the baseline happy-path reservation flow from S1 to S9 closure.
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `2a7fd454-82be-44ea-b0aa-57a582d44fac`
- **Inquiry ID**: `e01f8d43-24ac-492c-a020-f0d2af1887ab`
- **Result**: **PASS (flow executed to end)**

## API trace (request/response)

### S1 availability search
- **Goal**: Execute `POST` `/availability/search` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/availability/search",
  "body": {
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "checkInDate": "2026-04-25T00:00:00.000Z",
    "checkOutDate": "2026-04-26T00:00:00.000Z",
    "guestCount": 1,
    "useType": "LEISURE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "configurationId": "5bea035f-3956-48f9-a8cc-981cdc27dcbc",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "queriedAt": "2026-04-25T11:19:27.968Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "5fe74184-655b-4699-afe1-580a929f4d14",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "5fe74184-655b-4699-afe1-580a929f4d14"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "b7e98134-0955-433a-9b27-aee067216098",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "b7e98134-0955-433a-9b27-aee067216098"
      },
      {
        "inventoryId": "ed3b35da-35b0-43bd-bf90-bfbdb076bd07",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "ed3b35da-35b0-43bd-bf90-bfbdb076bd07"
      },
      {
        "inventoryId": "f52da834-aaec-420b-be00-deb3c98382f0",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "f52da834-aaec-420b-be00-deb3c98382f0"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "42aa3b83-0ff7-4de5-9c27-ce7ed7a3c3ac",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "42aa3b83-0ff7-4de5-9c27-ce7ed7a3c3ac"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-25T11:19:27.967Z",
    "isRevalidationRequired": false
  }
}
```

- **Achieved**: YES

### S1 select availability option
- **Goal**: Execute `PATCH` `/availability/configurations/5bea035f-3956-48f9-a8cc-981cdc27dcbc/select` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/availability/configurations/5bea035f-3956-48f9-a8cc-981cdc27dcbc/select",
  "body": {
    "roomId": "5fe74184-655b-4699-afe1-580a929f4d14"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "5bea035f-3956-48f9-a8cc-981cdc27dcbc",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "useType": "LEISURE",
    "guestCount": 1,
    "checkInDate": "2026-04-25T00:00:00.000Z",
    "checkOutDate": "2026-04-26T00:00:00.000Z"
  },
  "resultSet": {
    "availableRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "401",
        "inventoryId": "5fe74184-655b-4699-afe1-580a929f4d14"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "42aa3b83-0ff7-4de5-9c27-ce7ed7a3c3ac",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-25T11:19:27.967Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "b7e98134-0955-433a-9b27-aee067216098",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "ed3b35da-35b0-43bd-bf90-bfbdb076bd07",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "f52da834-aaec-420b-be00-deb3c98382f0",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "5fe74184-655b-4699-afe1-580a929f4d14",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-25T11:19:27.968Z",
  "createdBy": "e2e-fd-1"
}
```

- **Achieved**: YES

### S1->S2 progress-stage
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage",
  "body": {
    "targetStage": "S2",
    "version": 1
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "inquiryId": "e01f8d43-24ac-492c-a020-f0d2af1887ab",
  "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-04-25T00:00:00.000Z",
  "checkOutDate": "2026-04-26T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-25T11:19:27.915Z",
  "updatedAt": "2026-04-25T11:19:28.051Z",
  "createdBy": "e2e-fd-1",
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

- **Achieved**: YES

### S2 create quotation
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/quotations` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/quotations",
  "body": {
    "roomTypeId": null,
    "nightlyRate": 100,
    "currency": "BTN",
    "notes": "e2e quotation"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "dea0cd93-e8d0-4a9a-bfee-c77e862bf172",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "segmentId": "d5197ed3-9273-43ec-b0df-4356059057d7",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "69eaa35b-94e4-41d9-95fb-4f30710f6aa8",
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
  "createdAt": "2026-04-25T11:19:28.082Z",
  "createdBy": "e2e-fd-1"
}
```

- **Achieved**: YES

### S2 send quotation
- **Goal**: Execute `POST` `/quotations/dea0cd93-e8d0-4a9a-bfee-c77e862bf172/send` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/quotations/dea0cd93-e8d0-4a9a-bfee-c77e862bf172/send",
  "body": {
    "id": "dea0cd93-e8d0-4a9a-bfee-c77e862bf172",
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "segmentId": "d5197ed3-9273-43ec-b0df-4356059057d7",
    "versionNumber": 1,
    "referenceNumber": "Q-001",
    "state": "SENT",
    "commercialTerms": {
      "notes": "e2e quotation",
      "useType": "LEISURE",
      "currency": "BTN",
      "inclusions": [],
      "roomTypeId": "69eaa35b-94e4-41d9-95fb-4f30710f6aa8",
      "resolvedRateAmount": 500,
      "resolvedRatePlanId": "rp-dlx-default"
    },
    "totalAmount": "500",
    "currency": "BTN",
    "validUntil": "2026-04-27T11:19:28.104Z",
    "sentAt": "2026-04-25T11:19:28.104Z",
    "sentTo": null,
    "communicationRecordId": null,
    "supersededById": null,
    "supersededAt": null,
    "expiredAt": null,
    "acceptedAt": null,
    "acceptedBy": null,
    "folioId": null,
    "sealedAt": null,
    "createdAt": "2026-04-25T11:19:28.082Z",
    "createdBy": "e2e-fd-1"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S2 accept quotation
- **Goal**: Execute `POST` `/quotations/dea0cd93-e8d0-4a9a-bfee-c77e862bf172/accept` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/quotations/dea0cd93-e8d0-4a9a-bfee-c77e862bf172/accept",
  "body": {
    "id": "dea0cd93-e8d0-4a9a-bfee-c77e862bf172",
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "segmentId": "d5197ed3-9273-43ec-b0df-4356059057d7",
    "versionNumber": 1,
    "referenceNumber": "Q-001",
    "state": "ACCEPTED",
    "commercialTerms": {
      "notes": "e2e quotation",
      "useType": "LEISURE",
      "currency": "BTN",
      "inclusions": [],
      "roomTypeId": "69eaa35b-94e4-41d9-95fb-4f30710f6aa8",
      "resolvedRateAmount": 500,
      "resolvedRatePlanId": "rp-dlx-default"
    },
    "totalAmount": "500",
    "currency": "BTN",
    "validUntil": "2026-04-27T11:19:28.104Z",
    "sentAt": "2026-04-25T11:19:28.104Z",
    "sentTo": null,
    "communicationRecordId": "52727d09-00fe-46a8-995b-7e4965f7d109",
    "supersededById": null,
    "supersededAt": null,
    "expiredAt": null,
    "acceptedAt": "2026-04-25T11:19:28.238Z",
    "acceptedBy": "e2e-fd-1",
    "folioId": null,
    "sealedAt": null,
    "createdAt": "2026-04-25T11:19:28.082Z",
    "createdBy": "e2e-fd-1"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S2->S3 progress-stage
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage",
  "body": {
    "targetStage": "S3",
    "version": 2
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "inquiryId": "e01f8d43-24ac-492c-a020-f0d2af1887ab",
  "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S3",
  "walkInCompressed": false,
  "checkInDate": "2026-04-25T00:00:00.000Z",
  "checkOutDate": "2026-04-26T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-25T11:19:27.915Z",
  "updatedAt": "2026-04-25T11:19:28.313Z",
  "createdBy": "e2e-fd-1",
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

- **Achieved**: YES

### S3 ensure provisional folio + billing model
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/folio/provisional` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/folio/provisional",
  "body": {
    "billingModel": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "3ab7a030-c545-4641-905d-a41a156fc15f",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-25T11:19:28.340Z",
  "createdBy": "e2e-fd-1",
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
      "id": "087c994c-910d-4672-8eba-6dbb181703ab",
      "folioId": "3ab7a030-c545-4641-905d-a41a156fc15f",
      "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-25T11:19:28.343Z",
      "issuedBy": "e2e-fd-1",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-25T11:19:28.344Z"
    }
  ]
}
```

- **Achieved**: YES

### S3 record advance payment
- **Goal**: Execute `POST` `/folios/3ab7a030-c545-4641-905d-a41a156fc15f/payments` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/folios/3ab7a030-c545-4641-905d-a41a156fc15f/payments",
  "body": {
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "amount": 1000,
    "notes": "e2e advance payment"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "be01fea9-599a-49ac-967b-b17772d40c02",
  "folioId": "3ab7a030-c545-4641-905d-a41a156fc15f",
  "invoiceId": null,
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "amount": "1000",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-25T11:19:28.380Z",
  "receivedAt": "2026-04-25T11:19:28.379Z",
  "recordedBy": "e2e-fd-1",
  "stage": "S3",
  "notes": "e2e advance payment"
}
```

- **Achieved**: YES

### S3 reconcile advance payment
- **Goal**: Execute `POST` `/folios/3ab7a030-c545-4641-905d-a41a156fc15f/advance-payment/reconcile` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/folios/3ab7a030-c545-4641-905d-a41a156fc15f/advance-payment/reconcile",
  "body": {
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "note": "e2e reconcile"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "3ab7a030-c545-4641-905d-a41a156fc15f",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-25T11:19:28.340Z",
  "createdBy": "e2e-fd-1",
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

- **Achieved**: YES

### S3 cancellation disclosure
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/disclosures/cancellation` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/disclosures/cancellation",
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
  "id": "38c9e31a-3c6a-41df-b09c-8c6bce89c1c2",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "segmentId": "d5197ed3-9273-43ec-b0df-4356059057d7",
  "noShowTreatmentStatement": "Standard no-show policy",
  "disclosedTerms": {
    "windowHours": 24
  },
  "disclosedAt": "2026-04-25T11:19:28.435Z",
  "disclosedBy": "e2e-fd-1"
}
```

- **Achieved**: YES

### S3 committed hold
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/holds/committed` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/holds/committed",
  "body": {
    "roomId": "5fe74184-655b-4699-afe1-580a929f4d14",
    "commercialJustification": "Basic reservation committed hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "d697baf5-6226-4da9-b214-431d8f77fa3f",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "segmentId": "d5197ed3-9273-43ec-b0df-4356059057d7",
  "roomId": "5fe74184-655b-4699-afe1-580a929f4d14",
  "spaceId": null,
  "roomTypeId": "69eaa35b-94e4-41d9-95fb-4f30710f6aa8",
  "state": "PLACED",
  "placedAt": "2026-04-25T11:19:28.475Z",
  "placedBy": "e2e-fd-1",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "Basic reservation committed hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-25T12:19:28.475Z"
}
```

- **Achieved**: YES

### S3->S4 confirm reservation
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/confirm` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/confirm",
  "body": {
    "version": 3
  }
}
```

- **Response**: HTTP 200

```json
{
  "reservation": {
    "id": "0d8d8881-de58-4992-ac0d-2c3c7c748492",
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "segmentId": "d5197ed3-9273-43ec-b0df-4356059057d7",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {
      "windowHours": 24
    },
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-04-25T00:00:00.000Z",
    "frozenCheckOutDate": "2026-04-26T00:00:00.000Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-04-25T11:19:28.531Z",
    "confirmedBy": "e2e-fd-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-25T11:19:28.532Z"
  },
  "entry": {
    "id": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "inquiryId": "e01f8d43-24ac-492c-a020-f0d2af1887ab",
    "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-04-25T00:00:00.000Z",
    "checkOutDate": "2026-04-26T00:00:00.000Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-04-25T11:19:27.915Z",
    "updatedAt": "2026-04-25T11:19:28.544Z",
    "createdBy": "e2e-fd-1",
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

- **Achieved**: YES

### W4 pre-arrival activation (manual trigger)
- **Goal**: Execute `WORKER` `PRE_ARRIVAL_COUNTDOWN_W4` and advance scenario state.
- **Request**: actor `L1`/`SYSTEM`

```json
{
  "method": "WORKER",
  "path": "PRE_ARRIVAL_COUNTDOWN_W4",
  "body": {
    "skipped": false,
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S5 complete pre-arrival task 197855d4-675f-425c-9fe9-5fa52212313f
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/197855d4-675f-425c-9fe9-5fa52212313f` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/197855d4-675f-425c-9fe9-5fa52212313f",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "197855d4-675f-425c-9fe9-5fa52212313f",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "taskType": "PAYMENT_RECONCILIATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-25T11:19:38.773Z",
  "completedBy": "e2e-fd-1",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-25T11:19:38.709Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 807a49b5-2a32-4533-9b11-7ace16e9f85d
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/807a49b5-2a32-4533-9b11-7ace16e9f85d` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/807a49b5-2a32-4533-9b11-7ace16e9f85d",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "807a49b5-2a32-4533-9b11-7ace16e9f85d",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "taskType": "NIGHT_AUDIT_TIMER_REGISTRATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-25T11:19:38.801Z",
  "completedBy": "e2e-fd-1",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-25T11:19:38.709Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task ceb697a5-9d9e-48e2-a5d0-8c790b10ece5
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/ceb697a5-9d9e-48e2-a5d0-8c790b10ece5` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/ceb697a5-9d9e-48e2-a5d0-8c790b10ece5",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "ceb697a5-9d9e-48e2-a5d0-8c790b10ece5",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "taskType": "BED_CONFIGURATION_CHANGE",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-25T11:19:38.832Z",
  "completedBy": "e2e-fd-1",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-25T11:19:38.709Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 7323913c-882c-49e8-beef-479a1481cf7a
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/7323913c-882c-49e8-beef-479a1481cf7a` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/7323913c-882c-49e8-beef-479a1481cf7a",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7323913c-882c-49e8-beef-479a1481cf7a",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "taskType": "PRE_ARRIVAL_COMMUNICATION",
  "category": "COMMUNICATION",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-25T11:19:38.860Z",
  "completedBy": "e2e-fd-1",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-25T11:19:38.709Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 43c3e4f3-4e9d-447b-a473-a79934419040
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/43c3e4f3-4e9d-447b-a473-a79934419040` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/43c3e4f3-4e9d-447b-a473-a79934419040",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "43c3e4f3-4e9d-447b-a473-a79934419040",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "taskType": "SPECIAL_REQUEST_FULFILMENT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-25T11:19:38.886Z",
  "completedBy": "e2e-fd-1",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-25T11:19:38.709Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 6e09e714-1635-46c9-9ac4-a3f6dbbf9e81
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/6e09e714-1635-46c9-9ac4-a3f6dbbf9e81` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/6e09e714-1635-46c9-9ac4-a3f6dbbf9e81",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "6e09e714-1635-46c9-9ac4-a3f6dbbf9e81",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "taskType": "LATE_ARRIVAL_MEAL_COORDINATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-25T11:19:38.913Z",
  "completedBy": "e2e-fd-1",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-25T11:19:38.709Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 6c681df8-0283-40b8-9982-495fe2557448
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/6c681df8-0283-40b8-9982-495fe2557448` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/6c681df8-0283-40b8-9982-495fe2557448",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "6c681df8-0283-40b8-9982-495fe2557448",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "taskType": "SITE_VISIT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-25T11:19:38.939Z",
  "completedBy": "e2e-fd-1",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-25T11:19:38.709Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 8dee1e27-f936-4684-b3bd-27c15625b33f
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/8dee1e27-f936-4684-b3bd-27c15625b33f` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/8dee1e27-f936-4684-b3bd-27c15625b33f",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "8dee1e27-f936-4684-b3bd-27c15625b33f",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "taskType": "UNIT_READINESS_VERIFICATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-25T11:19:38.965Z",
  "completedBy": "e2e-fd-1",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-25T11:19:38.709Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 room assignment
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/room-assignments` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/room-assignments",
  "body": {
    "roomId": "5fe74184-655b-4699-afe1-580a929f4d14",
    "notes": "e2e assign"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "faec87fa-4793-4e9f-be58-43985ad6e494",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "roomId": "5fe74184-655b-4699-afe1-580a929f4d14",
  "assignedAt": "2026-04-25T11:19:38.996Z",
  "assignedBy": "e2e-fd-1",
  "deficientAtAssignment": false,
  "deficientConditionRecordId": null,
  "acknowledgementActorId": null,
  "acknowledgementAt": null,
  "notes": "e2e assign",
  "createdAt": "2026-04-25T11:19:38.996Z"
}
```

- **Achieved**: YES

### S5 accept H1
- **Goal**: Execute `POST` `/handoffs/cf07860f-cd7d-4b8e-aacf-83046117e337/accept` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/handoffs/cf07860f-cd7d-4b8e-aacf-83046117e337/accept",
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
  "id": "cf07860f-cd7d-4b8e-aacf-83046117e337",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "handoffType": "H1",
  "state": "ACCEPTED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-1",
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
  "acceptedAt": "2026-04-25T11:19:39.037Z",
  "acceptedBy": "e2e-fd-1",
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
  "createdAt": "2026-04-25T11:19:28.541Z",
  "createdBy": "e2e-fd-1",
  "stageContext": "S4"
}
```

- **Achieved**: YES

### S5 fulfil H1
- **Goal**: Execute `POST` `/handoffs/cf07860f-cd7d-4b8e-aacf-83046117e337/fulfil` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/handoffs/cf07860f-cd7d-4b8e-aacf-83046117e337/fulfil",
  "body": {
    "fulfilmentEvidence": {
      "roomAssignmentId": "faec87fa-4793-4e9f-be58-43985ad6e494",
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
  "id": "cf07860f-cd7d-4b8e-aacf-83046117e337",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "handoffType": "H1",
  "state": "FULFILLED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-1",
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
    "roomAssignmentId": "faec87fa-4793-4e9f-be58-43985ad6e494",
    "readinessConfirmed": true,
    "paymentStatusConfirmed": true,
    "ceilingProximityAddressed": true
  },
  "assignedAt": null,
  "acceptedAt": "2026-04-25T11:19:39.037Z",
  "acceptedBy": "e2e-fd-1",
  "fulfilledAt": "2026-04-25T11:19:39.067Z",
  "fulfilledBy": "e2e-fd-1",
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
  "createdAt": "2026-04-25T11:19:28.541Z",
  "createdBy": "e2e-fd-1",
  "stageContext": "S4"
}
```

- **Achieved**: YES

### S5->S6 progress-stage (guest present)
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage",
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
  "id": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "inquiryId": "e01f8d43-24ac-492c-a020-f0d2af1887ab",
  "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S6",
  "walkInCompressed": false,
  "checkInDate": "2026-04-25T00:00:00.000Z",
  "checkOutDate": "2026-04-26T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-25T11:19:27.915Z",
  "updatedAt": "2026-04-25T11:19:39.109Z",
  "createdBy": "e2e-fd-1",
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

- **Achieved**: YES

### S6 create H2
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/handoffs/h2` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/handoffs/h2",
  "body": {
    "roomNumber": "401",
    "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
    "deficientConditionStatus": null
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "c8d07da1-8be4-4915-9be5-033a5055bd1d",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "handoffType": "H2",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-1",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "roomNumber": "401",
    "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
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
  "slaDeadlineAt": "2026-04-25T12:19:39.153Z",
  "isAutoFulfilled": false,
  "createdAt": "2026-04-25T11:19:39.154Z",
  "createdBy": "e2e-fd-1",
  "stageContext": "S6"
}
```

- **Achieved**: YES

### S6 verify guest identity
- **Goal**: Execute `POST` `/guest-profiles/ae626e1e-cf4e-41c5-be5c-ff3aad1de296/verify-identity` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/guest-profiles/ae626e1e-cf4e-41c5-be5c-ff3aad1de296/verify-identity",
  "body": {
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "verificationPath": "FIRST_TIME",
    "documentType": "PASSPORT",
    "documentNumber": "E2E-1777115979173",
    "issuingCountry": "BT"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
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
  "identityVerifiedAt": "2026-04-25T11:19:39.190Z",
  "identityVerifiedBy": "e2e-fd-1",
  "identityVerificationPath": "FIRST_TIME",
  "createdAt": "2026-04-25T11:19:26.528Z",
  "updatedAt": "2026-04-25T11:19:39.190Z",
  "createdBy": "actor-seed-system"
}
```

- **Achieved**: YES

### S6->S7 progress-stage (complete check-in)
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage",
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
  "id": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "inquiryId": "e01f8d43-24ac-492c-a020-f0d2af1887ab",
  "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S7",
  "walkInCompressed": false,
  "checkInDate": "2026-04-25T00:00:00.000Z",
  "checkOutDate": "2026-04-26T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-25T11:19:27.915Z",
  "updatedAt": "2026-04-25T11:19:39.234Z",
  "createdBy": "e2e-fd-1",
  "version": 7,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T11:19:39.234Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-1",
  "registrationCompletedAt": "2026-04-25T11:19:39.234Z",
  "registrationCompletedBy": "e2e-fd-1",
  "folio": {
    "id": "3ab7a030-c545-4641-905d-a41a156fc15f",
    "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "state": "LIVE",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-25T11:19:28.340Z",
    "createdBy": "e2e-fd-1",
    "convertedToLiveAt": "2026-04-25T11:19:39.243Z",
    "convertedBy": "e2e-fd-1",
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
    "id": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
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
    "identityVerifiedAt": "2026-04-25T11:19:39.190Z",
    "identityVerifiedBy": "e2e-fd-1",
    "identityVerificationPath": "FIRST_TIME",
    "createdAt": "2026-04-25T11:19:26.528Z",
    "updatedAt": "2026-04-25T11:19:39.190Z",
    "createdBy": "actor-seed-system"
  },
  "handoffs": [
    {
      "id": "e680d124-5f17-41ec-9bf8-47afd4d36d87",
      "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
      "handoffType": "H3",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-1",
      "toRole": "F_AND_B",
      "toActorId": null,
      "checklistContent": {
        "mealPlan": "per reservation inclusions",
        "guestCount": 1,
        "roomNumber": "401",
        "stayDuration": {
          "checkInDate": "2026-04-25T00:00:00.000Z",
          "checkOutDate": "2026-04-26T00:00:00.000Z"
        },
        "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
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
      "slaDeadlineAt": "2026-04-25T12:19:39.234Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-25T11:19:39.240Z",
      "createdBy": "e2e-fd-1",
      "stageContext": "S6"
    },
    {
      "id": "c8d07da1-8be4-4915-9be5-033a5055bd1d",
      "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
      "handoffType": "H2",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-1",
      "toRole": "HOUSEKEEPING",
      "toActorId": null,
      "checklistContent": {
        "roomNumber": "401",
        "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
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
      "slaDeadlineAt": "2026-04-25T12:19:39.153Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-25T11:19:39.154Z",
      "createdBy": "e2e-fd-1",
      "stageContext": "S6"
    },
    {
      "id": "cf07860f-cd7d-4b8e-aacf-83046117e337",
      "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
      "handoffType": "H1",
      "state": "CLOSED",
      "fromRole": "RESERVATIONS",
      "fromActorId": "e2e-fd-1",
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
        "roomAssignmentId": "faec87fa-4793-4e9f-be58-43985ad6e494",
        "readinessConfirmed": true,
        "paymentStatusConfirmed": true,
        "ceilingProximityAddressed": true
      },
      "assignedAt": null,
      "acceptedAt": "2026-04-25T11:19:39.037Z",
      "acceptedBy": "e2e-fd-1",
      "fulfilledAt": "2026-04-25T11:19:39.067Z",
      "fulfilledBy": "e2e-fd-1",
      "closedAt": "2026-04-25T11:19:39.234Z",
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": null,
      "isAutoFulfilled": false,
      "createdAt": "2026-04-25T11:19:28.541Z",
      "createdBy": "e2e-fd-1",
      "stageContext": "S4"
    }
  ]
}
```

- **Achieved**: YES

### S7 run night audit (last operating date)
- **Goal**: Execute `POST` `/night-audit/run` and advance scenario state.
- **Request**: actor `L2`/`e2e-fom-1`

```json
{
  "method": "POST",
  "path": "/night-audit/run",
  "body": {
    "operatingDate": "2026-04-25T00:00:00.000Z"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "99ea45f2-a2a7-4898-8eab-bd09da98cb93",
  "operatingDate": "2026-04-25T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 3,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-25T11:19:39.314Z",
  "createdBy": "e2e-fom-1"
}
```

- **Achieved**: YES

### S7 initiate H4
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/handoffs/h4` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/handoffs/h4",
  "body": {
    "notes": "e2e pre-checkout handoff"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "31c4771f-7610-47fb-acef-584ac94e58cd",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "handoffType": "H4",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-1",
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
  "createdAt": "2026-04-25T11:19:39.360Z",
  "createdBy": "e2e-fd-1",
  "stageContext": "S7"
}
```

- **Achieved**: YES

### S7->S8 progress-stage (stay exit)
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage",
  "body": {
    "targetStage": "S8",
    "version": 7
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "inquiryId": "e01f8d43-24ac-492c-a020-f0d2af1887ab",
  "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S8",
  "walkInCompressed": false,
  "checkInDate": "2026-04-25T00:00:00.000Z",
  "checkOutDate": "2026-04-26T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-25T11:19:27.915Z",
  "updatedAt": "2026-04-25T11:19:39.406Z",
  "createdBy": "e2e-fd-1",
  "version": 8,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T11:19:39.234Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-1",
  "registrationCompletedAt": "2026-04-25T11:19:39.234Z",
  "registrationCompletedBy": "e2e-fd-1"
}
```

- **Achieved**: YES

### S8 record key return
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/key-return` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/key-return",
  "body": {
    "keyCountReturned": 2
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "6ec8c751-31c2-4623-a47d-232e9a72832b",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "roomId": "5fe74184-655b-4699-afe1-580a929f4d14",
  "receivedBy": "e2e-fd-1",
  "returnedAt": "2026-04-25T11:19:39.451Z",
  "keyCountIssued": 2,
  "keyCountReturned": 2,
  "countReconciled": true,
  "reconciliationNote": null,
  "createdAt": "2026-04-25T11:19:39.452Z"
}
```

- **Achieved**: YES

### S8 record room inspection
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/room-inspection` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/room-inspection",
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
  "id": "dc53aa20-a252-4a23-9ea3-79a69528b80c",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "roomId": "5fe74184-655b-4699-afe1-580a929f4d14",
  "segmentId": "d5197ed3-9273-43ec-b0df-4356059057d7",
  "inspectedBy": "e2e-fd-1",
  "inspectedAt": "2026-04-25T11:19:39.486Z",
  "isDeferred": false,
  "deficientFlagStatus": "NOT_APPLICABLE",
  "deficientConditionId": null,
  "inspectorAssessment": null,
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-04-25T11:19:39.487Z"
}
```

- **Achieved**: YES

### S8 fulfil H4
- **Goal**: Execute `POST` `/handoffs/31c4771f-7610-47fb-acef-584ac94e58cd/fulfil` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/handoffs/31c4771f-7610-47fb-acef-584ac94e58cd/fulfil",
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
  "id": "31c4771f-7610-47fb-acef-584ac94e58cd",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "handoffType": "H4",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-1",
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
  "fulfilledAt": "2026-04-25T11:19:39.518Z",
  "fulfilledBy": "e2e-fd-1",
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
  "createdAt": "2026-04-25T11:19:39.360Z",
  "createdBy": "e2e-fd-1",
  "stageContext": "S7"
}
```

- **Achieved**: YES

### S8 settle folio (CASH => SETTLED)
- **Goal**: Execute `POST` `/folios/3ab7a030-c545-4641-905d-a41a156fc15f/settle` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/folios/3ab7a030-c545-4641-905d-a41a156fc15f/settle",
  "body": {
    "settlementMethod": "CASH",
    "paymentVerificationRef": "CASH-1777115979537",
    "billingModelConfirmation": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "3ab7a030-c545-4641-905d-a41a156fc15f",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "state": "SETTLED",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-25T11:19:28.340Z",
  "createdBy": "e2e-fd-1",
  "convertedToLiveAt": "2026-04-25T11:19:39.243Z",
  "convertedBy": "e2e-fd-1",
  "closedAt": "2026-04-25T11:19:39.555Z",
  "closedBy": "e2e-fd-1",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": true
}
```

- **Achieved**: YES

### S8->S9 progress-stage (closure stage)
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/progress-stage",
  "body": {
    "targetStage": "S9",
    "version": 8
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "inquiryId": "e01f8d43-24ac-492c-a020-f0d2af1887ab",
  "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S9",
  "walkInCompressed": false,
  "checkInDate": "2026-04-25T00:00:00.000Z",
  "checkOutDate": "2026-04-26T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-25T11:19:27.915Z",
  "updatedAt": "2026-04-25T11:19:39.647Z",
  "createdBy": "e2e-fd-1",
  "version": 9,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T11:19:39.234Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-1",
  "registrationCompletedAt": "2026-04-25T11:19:39.234Z",
  "registrationCompletedBy": "e2e-fd-1"
}
```

- **Achieved**: YES

### S9 list invoices
- **Goal**: Execute `GET` `/folios/3ab7a030-c545-4641-905d-a41a156fc15f/invoices` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "GET",
  "path": "/folios/3ab7a030-c545-4641-905d-a41a156fc15f/invoices",
  "body": [
    {
      "id": "087c994c-910d-4672-8eba-6dbb181703ab",
      "folioId": "3ab7a030-c545-4641-905d-a41a156fc15f",
      "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-25T11:19:28.343Z",
      "issuedBy": "e2e-fd-1",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-25T11:19:28.344Z"
    }
  ]
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S9 dispatch invoice 087c994c-910d-4672-8eba-6dbb181703ab
- **Goal**: Execute `POST` `/invoices/087c994c-910d-4672-8eba-6dbb181703ab/dispatch` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-1`

```json
{
  "method": "POST",
  "path": "/invoices/087c994c-910d-4672-8eba-6dbb181703ab/dispatch",
  "body": {
    "dispatchedTo": "guest@example.com"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "087c994c-910d-4672-8eba-6dbb181703ab",
  "folioId": "3ab7a030-c545-4641-905d-a41a156fc15f",
  "entryId": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
  "invoiceType": "PROFORMA",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": "proforma-v1",
  "issuedAt": "2026-04-25T11:19:28.343Z",
  "issuedBy": "e2e-fd-1",
  "dispatchedAt": "2026-04-25T11:19:39.717Z",
  "dispatchedBy": "e2e-fd-1",
  "dispatchedTo": "guest@example.com",
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "basis": "S3 setup",
    "dispatchedAt": "2026-04-25T11:19:39.717Z",
    "dispatchedBy": "e2e-fd-1"
  },
  "createdAt": "2026-04-25T11:19:28.344Z"
}
```

- **Achieved**: YES

### S9 close entry
- **Goal**: Execute `POST` `/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/close` and advance scenario state.
- **Request**: actor `L2`/`e2e-fom-1`

```json
{
  "method": "POST",
  "path": "/entries/2a7fd454-82be-44ea-b0aa-57a582d44fac/close",
  "body": {
    "id": "2a7fd454-82be-44ea-b0aa-57a582d44fac",
    "inquiryId": "e01f8d43-24ac-492c-a020-f0d2af1887ab",
    "guestProfileId": "ae626e1e-cf4e-41c5-be5c-ff3aad1de296",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "CLOSED",
    "currentStage": "S9",
    "walkInCompressed": false,
    "checkInDate": "2026-04-25T00:00:00.000Z",
    "checkOutDate": "2026-04-26T00:00:00.000Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-04-25T11:19:27.915Z",
    "updatedAt": "2026-04-25T11:19:39.769Z",
    "createdBy": "e2e-fd-1",
    "version": 10,
    "closedAt": "2026-04-25T11:19:39.768Z",
    "closedBy": "e2e-fom-1",
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": "2026-04-25T11:19:39.234Z",
    "keysIssuedCount": 2,
    "keysIssuedBy": "e2e-fd-1",
    "registrationCompletedAt": "2026-04-25T11:19:39.234Z",
    "registrationCompletedBy": "e2e-fd-1"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

