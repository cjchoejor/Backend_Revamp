# Boss summary report

- **Source report**: `Documentation_V2/test/E2E-outstanding-writeoff-close.no-db.md`
- **Scenario title**: E2E outstanding + write-off + close — no DB diffs
- **Goal**: Validate OUTSTANDING folio write-off then close at S9 (GM authority).
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `69464aa7-77a8-43c8-a5a9-43045be29b95`
- **Inquiry ID**: `9e7f7f73-4369-402d-a07e-044c452087ce`
- **Result**: **PASS (flow executed to end)**

## API trace (request/response)

### S1 create inquiry
- **Goal**: Execute `POST` `/inquiries` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/inquiries",
  "body": {
    "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
    "sourceChannel": "WALK_IN",
    "notes": "e2e outstanding writeoff close"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "9e7f7f73-4369-402d-a07e-044c452087ce",
  "referenceNumber": "INQ-1777288621479-465381",
  "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
  "agentProfileId": null,
  "sourceChannel": "WALK_IN",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": "e2e outstanding writeoff close",
  "createdAt": "2026-04-27T11:17:01.480Z",
  "updatedAt": "2026-04-27T11:17:01.480Z",
  "createdBy": "e2e-fd-8",
  "parkedAt": null,
  "parkedBy": null
}
```

- **Achieved**: YES

### S1 create entry
- **Goal**: Execute `POST` `/entries` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries",
  "body": {
    "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
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
  "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
  "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "createdAt": "2026-04-27T11:17:01.496Z",
  "updatedAt": "2026-04-27T11:17:01.496Z",
  "createdBy": "e2e-fd-8",
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

- **Achieved**: YES

### S1 availability search
- **Goal**: Execute `POST` `/availability/search` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/availability/search",
  "body": {
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
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
  "configurationId": "33c9a4c9-9bfa-4bed-9a39-2fc952aaf73d",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "queriedAt": "2026-04-27T11:17:01.510Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "c05e5d2e-c58f-4a27-af93-7a99041f081c",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "c05e5d2e-c58f-4a27-af93-7a99041f081c"
      },
      {
        "inventoryId": "27da8a96-020b-4bd6-9ffb-6e458bf905cc",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "27da8a96-020b-4bd6-9ffb-6e458bf905cc"
      },
      {
        "inventoryId": "5c6b5111-9367-43f9-aa3a-a12efa61dbcb",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "5c6b5111-9367-43f9-aa3a-a12efa61dbcb"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "b646e3ed-53b1-4f81-93e6-d6ba8f061628",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "b646e3ed-53b1-4f81-93e6-d6ba8f061628"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-27T11:17:01.509Z",
    "isRevalidationRequired": false
  }
}
```

- **Achieved**: YES

### S1 select availability option
- **Goal**: Execute `PATCH` `/availability/configurations/33c9a4c9-9bfa-4bed-9a39-2fc952aaf73d/select` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/availability/configurations/33c9a4c9-9bfa-4bed-9a39-2fc952aaf73d/select",
  "body": {
    "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "33c9a4c9-9bfa-4bed-9a39-2fc952aaf73d",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
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
        "inventoryId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "b646e3ed-53b1-4f81-93e6-d6ba8f061628",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-27T11:17:01.509Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "c05e5d2e-c58f-4a27-af93-7a99041f081c",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "27da8a96-020b-4bd6-9ffb-6e458bf905cc",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "5c6b5111-9367-43f9-aa3a-a12efa61dbcb",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T11:17:01.510Z",
  "createdBy": "e2e-fd-8"
}
```

- **Achieved**: YES

### S1->S2 progress-stage
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage",
  "body": {
    "targetStage": "S2",
    "version": 1
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
  "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "createdAt": "2026-04-27T11:17:01.496Z",
  "updatedAt": "2026-04-27T11:17:01.541Z",
  "createdBy": "e2e-fd-8",
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
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/quotations` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/quotations",
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
  "id": "2a81c83c-b97f-4ac4-962d-fcf5f7acd71e",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "segmentId": "63732e15-1662-4ad7-b9e7-37c98d08453b",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "quote",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "539cf2bd-8d93-4f9f-ba5b-c8f6887ecbe6",
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
  "createdAt": "2026-04-27T11:17:01.553Z",
  "createdBy": "e2e-fd-8"
}
```

- **Achieved**: YES

### S2 send quotation
- **Goal**: Execute `POST` `/quotations/2a81c83c-b97f-4ac4-962d-fcf5f7acd71e/send` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/quotations/2a81c83c-b97f-4ac4-962d-fcf5f7acd71e/send",
  "body": {
    "id": "2a81c83c-b97f-4ac4-962d-fcf5f7acd71e",
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "segmentId": "63732e15-1662-4ad7-b9e7-37c98d08453b",
    "versionNumber": 1,
    "referenceNumber": "Q-001",
    "state": "SENT",
    "commercialTerms": {
      "notes": "quote",
      "useType": "LEISURE",
      "currency": "BTN",
      "inclusions": [],
      "roomTypeId": "539cf2bd-8d93-4f9f-ba5b-c8f6887ecbe6",
      "resolvedRateAmount": 500,
      "resolvedRatePlanId": "rp-dlx-default"
    },
    "totalAmount": "500",
    "currency": "BTN",
    "validUntil": "2026-04-29T11:17:01.560Z",
    "sentAt": "2026-04-27T11:17:01.560Z",
    "sentTo": null,
    "communicationRecordId": null,
    "supersededById": null,
    "supersededAt": null,
    "expiredAt": null,
    "acceptedAt": null,
    "acceptedBy": null,
    "folioId": null,
    "sealedAt": null,
    "createdAt": "2026-04-27T11:17:01.553Z",
    "createdBy": "e2e-fd-8"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S2 accept quotation
- **Goal**: Execute `POST` `/quotations/2a81c83c-b97f-4ac4-962d-fcf5f7acd71e/accept` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/quotations/2a81c83c-b97f-4ac4-962d-fcf5f7acd71e/accept",
  "body": {
    "id": "2a81c83c-b97f-4ac4-962d-fcf5f7acd71e",
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "segmentId": "63732e15-1662-4ad7-b9e7-37c98d08453b",
    "versionNumber": 1,
    "referenceNumber": "Q-001",
    "state": "ACCEPTED",
    "commercialTerms": {
      "notes": "quote",
      "useType": "LEISURE",
      "currency": "BTN",
      "inclusions": [],
      "roomTypeId": "539cf2bd-8d93-4f9f-ba5b-c8f6887ecbe6",
      "resolvedRateAmount": 500,
      "resolvedRatePlanId": "rp-dlx-default"
    },
    "totalAmount": "500",
    "currency": "BTN",
    "validUntil": "2026-04-29T11:17:01.560Z",
    "sentAt": "2026-04-27T11:17:01.560Z",
    "sentTo": null,
    "communicationRecordId": "dca77791-0a65-431e-a7bf-1ec3d338271c",
    "supersededById": null,
    "supersededAt": null,
    "expiredAt": null,
    "acceptedAt": "2026-04-27T11:17:01.584Z",
    "acceptedBy": "e2e-fd-8",
    "folioId": null,
    "sealedAt": null,
    "createdAt": "2026-04-27T11:17:01.553Z",
    "createdBy": "e2e-fd-8"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S2->S3 progress-stage
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage",
  "body": {
    "targetStage": "S3",
    "version": 2
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
  "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "createdAt": "2026-04-27T11:17:01.496Z",
  "updatedAt": "2026-04-27T11:17:01.607Z",
  "createdBy": "e2e-fd-8",
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
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/folio/provisional` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/folio/provisional",
  "body": {
    "billingModel": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "0cc4599e-394f-4c13-b309-b80de96122c8",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:17:01.615Z",
  "createdBy": "e2e-fd-8",
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
      "id": "5baa054f-eefe-4ce6-9ecf-180612ea8260",
      "folioId": "0cc4599e-394f-4c13-b309-b80de96122c8",
      "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T11:17:01.616Z",
      "issuedBy": "e2e-fd-8",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T11:17:01.617Z"
    }
  ]
}
```

- **Achieved**: YES

### S3 record advance payment
- **Goal**: Execute `POST` `/folios/0cc4599e-394f-4c13-b309-b80de96122c8/payments` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/folios/0cc4599e-394f-4c13-b309-b80de96122c8/payments",
  "body": {
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "amount": 500,
    "notes": "advance"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "49fef7a0-e5ec-4e4c-b7cf-0f3ccfb37971",
  "folioId": "0cc4599e-394f-4c13-b309-b80de96122c8",
  "invoiceId": null,
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "amount": "500",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-27T11:17:01.626Z",
  "receivedAt": "2026-04-27T11:17:01.625Z",
  "recordedBy": "e2e-fd-8",
  "stage": "S3",
  "notes": "advance"
}
```

- **Achieved**: YES

### S3 reconcile advance payment
- **Goal**: Execute `POST` `/folios/0cc4599e-394f-4c13-b309-b80de96122c8/advance-payment/reconcile` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/folios/0cc4599e-394f-4c13-b309-b80de96122c8/advance-payment/reconcile",
  "body": {
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "note": "reconcile"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "0cc4599e-394f-4c13-b309-b80de96122c8",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:17:01.615Z",
  "createdBy": "e2e-fd-8",
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
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/disclosures/cancellation` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/disclosures/cancellation",
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
  "id": "ab51cea4-b1f6-48d3-803e-a2a51355b1c8",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "segmentId": "63732e15-1662-4ad7-b9e7-37c98d08453b",
  "noShowTreatmentStatement": "terms",
  "disclosedTerms": {
    "windowHours": 24
  },
  "disclosedAt": "2026-04-27T11:17:01.640Z",
  "disclosedBy": "e2e-fd-8"
}
```

- **Achieved**: YES

### S3 committed hold
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/holds/committed` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/holds/committed",
  "body": {
    "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36",
    "commercialJustification": "hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "ddb6979e-f862-47c4-bd80-6395348846f8",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "segmentId": "63732e15-1662-4ad7-b9e7-37c98d08453b",
  "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36",
  "spaceId": null,
  "roomTypeId": "539cf2bd-8d93-4f9f-ba5b-c8f6887ecbe6",
  "state": "PLACED",
  "placedAt": "2026-04-27T11:17:01.658Z",
  "placedBy": "e2e-fd-8",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-27T12:17:01.658Z"
}
```

- **Achieved**: YES

### S3->S4 confirm reservation
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/confirm` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/confirm",
  "body": {
    "version": 3
  }
}
```

- **Response**: HTTP 200

```json
{
  "reservation": {
    "id": "668f24a3-aedd-4732-ac12-d0831105c187",
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "segmentId": "63732e15-1662-4ad7-b9e7-37c98d08453b",
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
    "confirmedAt": "2026-04-27T11:17:01.683Z",
    "confirmedBy": "e2e-fd-8",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-27T11:17:01.684Z"
  },
  "entry": {
    "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
    "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
    "createdAt": "2026-04-27T11:17:01.496Z",
    "updatedAt": "2026-04-27T11:17:01.694Z",
    "createdBy": "e2e-fd-8",
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
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S5 complete pre-arrival task 3d8fc984-2ca5-455a-b270-9224ee13695e
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/3d8fc984-2ca5-455a-b270-9224ee13695e` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/3d8fc984-2ca5-455a-b270-9224ee13695e",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "3d8fc984-2ca5-455a-b270-9224ee13695e",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "taskType": "PAYMENT_RECONCILIATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:17:12.017Z",
  "completedBy": "e2e-fd-8",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:17:11.970Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 0ecbc305-2267-4bdf-88e7-6b97705ec2b7
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/0ecbc305-2267-4bdf-88e7-6b97705ec2b7` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/0ecbc305-2267-4bdf-88e7-6b97705ec2b7",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "0ecbc305-2267-4bdf-88e7-6b97705ec2b7",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "taskType": "NIGHT_AUDIT_TIMER_REGISTRATION",
  "category": "ADMINISTRATIVE",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:17:12.021Z",
  "completedBy": "e2e-fd-8",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:17:11.970Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 0a740c96-173d-4a9c-a26d-9bc308cdc72b
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/0a740c96-173d-4a9c-a26d-9bc308cdc72b` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/0a740c96-173d-4a9c-a26d-9bc308cdc72b",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "0a740c96-173d-4a9c-a26d-9bc308cdc72b",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "taskType": "BED_CONFIGURATION_CHANGE",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:17:12.025Z",
  "completedBy": "e2e-fd-8",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:17:11.970Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task e02d0789-17ef-417d-8b20-80bf8231ce0c
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/e02d0789-17ef-417d-8b20-80bf8231ce0c` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/e02d0789-17ef-417d-8b20-80bf8231ce0c",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "e02d0789-17ef-417d-8b20-80bf8231ce0c",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "taskType": "PRE_ARRIVAL_COMMUNICATION",
  "category": "COMMUNICATION",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:17:12.030Z",
  "completedBy": "e2e-fd-8",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:17:11.970Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 49f38efd-46a9-4390-9f1d-7bf2d65b4778
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/49f38efd-46a9-4390-9f1d-7bf2d65b4778` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/49f38efd-46a9-4390-9f1d-7bf2d65b4778",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "49f38efd-46a9-4390-9f1d-7bf2d65b4778",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "taskType": "SPECIAL_REQUEST_FULFILMENT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:17:12.035Z",
  "completedBy": "e2e-fd-8",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:17:11.970Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task a81deeb1-bdb2-43f1-b75a-7c74e63d61eb
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/a81deeb1-bdb2-43f1-b75a-7c74e63d61eb` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/a81deeb1-bdb2-43f1-b75a-7c74e63d61eb",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "a81deeb1-bdb2-43f1-b75a-7c74e63d61eb",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "taskType": "LATE_ARRIVAL_MEAL_COORDINATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:17:12.039Z",
  "completedBy": "e2e-fd-8",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:17:11.970Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task 6de56af1-53ea-453b-b6de-6b65b30d89a5
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/6de56af1-53ea-453b-b6de-6b65b30d89a5` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/6de56af1-53ea-453b-b6de-6b65b30d89a5",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "6de56af1-53ea-453b-b6de-6b65b30d89a5",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "taskType": "SITE_VISIT",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:17:12.043Z",
  "completedBy": "e2e-fd-8",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:17:11.970Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 complete pre-arrival task ba8b1d44-7cac-48a2-9fb4-18f4017fee65
- **Goal**: Execute `PATCH` `/pre-arrival-tasks/ba8b1d44-7cac-48a2-9fb4-18f4017fee65` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "PATCH",
  "path": "/pre-arrival-tasks/ba8b1d44-7cac-48a2-9fb4-18f4017fee65",
  "body": {
    "action": "COMPLETE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "ba8b1d44-7cac-48a2-9fb4-18f4017fee65",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "taskType": "UNIT_READINESS_VERIFICATION",
  "category": "OPERATIONAL",
  "targetDate": null,
  "status": "COMPLETE",
  "assignedTo": null,
  "assignedDepartment": null,
  "completedAt": "2026-04-27T11:17:12.046Z",
  "completedBy": "e2e-fd-8",
  "waivedReason": null,
  "waivedBy": null,
  "sourceRecordType": null,
  "sourceRecordId": null,
  "createdAt": "2026-04-27T11:17:11.970Z",
  "createdBy": "SYSTEM"
}
```

- **Achieved**: YES

### S5 room assignment
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/room-assignments` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/room-assignments",
  "body": {
    "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36",
    "notes": "assign"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "fdc4c19a-7da3-48ab-87d4-e6d72a55545d",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36",
  "assignedAt": "2026-04-27T11:17:12.053Z",
  "assignedBy": "e2e-fd-8",
  "deficientAtAssignment": false,
  "deficientConditionRecordId": null,
  "acknowledgementActorId": null,
  "acknowledgementAt": null,
  "notes": "assign",
  "createdAt": "2026-04-27T11:17:12.053Z"
}
```

- **Achieved**: YES

### S5 accept H1
- **Goal**: Execute `POST` `/handoffs/2ebd9e76-73b4-47d9-bc71-57d9566b8b92/accept` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/handoffs/2ebd9e76-73b4-47d9-bc71-57d9566b8b92/accept",
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
  "id": "2ebd9e76-73b4-47d9-bc71-57d9566b8b92",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "handoffType": "H1",
  "state": "ACCEPTED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-8",
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
  "acceptedAt": "2026-04-27T11:17:12.063Z",
  "acceptedBy": "e2e-fd-8",
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
  "createdAt": "2026-04-27T11:17:01.692Z",
  "createdBy": "e2e-fd-8",
  "stageContext": "S4"
}
```

- **Achieved**: YES

### S5 fulfil H1
- **Goal**: Execute `POST` `/handoffs/2ebd9e76-73b4-47d9-bc71-57d9566b8b92/fulfil` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/handoffs/2ebd9e76-73b4-47d9-bc71-57d9566b8b92/fulfil",
  "body": {
    "fulfilmentEvidence": {
      "roomAssignmentId": "fdc4c19a-7da3-48ab-87d4-e6d72a55545d",
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
  "id": "2ebd9e76-73b4-47d9-bc71-57d9566b8b92",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "handoffType": "H1",
  "state": "FULFILLED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-8",
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
    "roomAssignmentId": "fdc4c19a-7da3-48ab-87d4-e6d72a55545d",
    "readinessConfirmed": true,
    "paymentStatusConfirmed": true,
    "ceilingProximityAddressed": true
  },
  "assignedAt": null,
  "acceptedAt": "2026-04-27T11:17:12.063Z",
  "acceptedBy": "e2e-fd-8",
  "fulfilledAt": "2026-04-27T11:17:12.066Z",
  "fulfilledBy": "e2e-fd-8",
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
  "createdAt": "2026-04-27T11:17:01.692Z",
  "createdBy": "e2e-fd-8",
  "stageContext": "S4"
}
```

- **Achieved**: YES

### S5->S6 progress-stage
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage",
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
  "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
  "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "createdAt": "2026-04-27T11:17:01.496Z",
  "updatedAt": "2026-04-27T11:17:12.081Z",
  "createdBy": "e2e-fd-8",
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
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/handoffs/h2` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/handoffs/h2",
  "body": {
    "roomNumber": "401",
    "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
    "deficientConditionStatus": null
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "4a3991f2-253c-46f9-9117-a83106126d33",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "handoffType": "H2",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-8",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "roomNumber": "401",
    "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "slaDeadlineAt": "2026-04-27T12:17:12.096Z",
  "isAutoFulfilled": false,
  "createdAt": "2026-04-27T11:17:12.097Z",
  "createdBy": "e2e-fd-8",
  "stageContext": "S6"
}
```

- **Achieved**: YES

### S6 verify guest identity
- **Goal**: Execute `POST` `/guest-profiles/9b33e663-9a0a-4d0f-a7e1-85c0235453d5/verify-identity` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/guest-profiles/9b33e663-9a0a-4d0f-a7e1-85c0235453d5/verify-identity",
  "body": {
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "verificationPath": "FIRST_TIME",
    "documentType": "PASSPORT",
    "documentNumber": "E2E-1777288632104",
    "issuingCountry": "BT"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "identityVerifiedAt": "2026-04-27T11:17:12.109Z",
  "identityVerifiedBy": "e2e-fd-8",
  "identityVerificationPath": "FIRST_TIME",
  "createdAt": "2026-04-27T11:16:59.959Z",
  "updatedAt": "2026-04-27T11:17:12.109Z",
  "createdBy": "actor-seed-system"
}
```

- **Achieved**: YES

### S6->S7 progress-stage
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage",
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
  "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
  "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "createdAt": "2026-04-27T11:17:01.496Z",
  "updatedAt": "2026-04-27T11:17:12.124Z",
  "createdBy": "e2e-fd-8",
  "version": 7,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:17:12.124Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-8",
  "registrationCompletedAt": "2026-04-27T11:17:12.124Z",
  "registrationCompletedBy": "e2e-fd-8",
  "folio": {
    "id": "0cc4599e-394f-4c13-b309-b80de96122c8",
    "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "state": "LIVE",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-27T11:17:01.615Z",
    "createdBy": "e2e-fd-8",
    "convertedToLiveAt": "2026-04-27T11:17:12.133Z",
    "convertedBy": "e2e-fd-8",
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
    "id": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
    "identityVerifiedAt": "2026-04-27T11:17:12.109Z",
    "identityVerifiedBy": "e2e-fd-8",
    "identityVerificationPath": "FIRST_TIME",
    "createdAt": "2026-04-27T11:16:59.959Z",
    "updatedAt": "2026-04-27T11:17:12.109Z",
    "createdBy": "actor-seed-system"
  },
  "handoffs": [
    {
      "id": "8538afc8-8c77-4921-820a-41416b2bb5e9",
      "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
      "handoffType": "H3",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-8",
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
        "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
      "slaDeadlineAt": "2026-04-27T12:17:12.124Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:17:12.130Z",
      "createdBy": "e2e-fd-8",
      "stageContext": "S6"
    },
    {
      "id": "4a3991f2-253c-46f9-9117-a83106126d33",
      "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
      "handoffType": "H2",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-8",
      "toRole": "HOUSEKEEPING",
      "toActorId": null,
      "checklistContent": {
        "roomNumber": "401",
        "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
      "slaDeadlineAt": "2026-04-27T12:17:12.096Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:17:12.097Z",
      "createdBy": "e2e-fd-8",
      "stageContext": "S6"
    },
    {
      "id": "2ebd9e76-73b4-47d9-bc71-57d9566b8b92",
      "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
      "handoffType": "H1",
      "state": "CLOSED",
      "fromRole": "RESERVATIONS",
      "fromActorId": "e2e-fd-8",
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
        "roomAssignmentId": "fdc4c19a-7da3-48ab-87d4-e6d72a55545d",
        "readinessConfirmed": true,
        "paymentStatusConfirmed": true,
        "ceilingProximityAddressed": true
      },
      "assignedAt": null,
      "acceptedAt": "2026-04-27T11:17:12.063Z",
      "acceptedBy": "e2e-fd-8",
      "fulfilledAt": "2026-04-27T11:17:12.066Z",
      "fulfilledBy": "e2e-fd-8",
      "closedAt": "2026-04-27T11:17:12.124Z",
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": null,
      "isAutoFulfilled": false,
      "createdAt": "2026-04-27T11:17:01.692Z",
      "createdBy": "e2e-fd-8",
      "stageContext": "S4"
    }
  ]
}
```

- **Achieved**: YES

### S7 run night audit
- **Goal**: Execute `POST` `/night-audit/run` and advance scenario state.
- **Request**: actor `L2`/`e2e-fom-8`

```json
{
  "method": "POST",
  "path": "/night-audit/run",
  "body": {
    "operatingDate": "2026-04-27T00:00:00.000Z"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "7f3df372-be0c-4587-871f-baafb912ef3a",
  "operatingDate": "2026-04-27T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 3,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-27T11:17:12.175Z",
  "createdBy": "e2e-fom-8"
}
```

- **Achieved**: YES

### S7 initiate H4
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/handoffs/h4` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/handoffs/h4",
  "body": {
    "notes": "h4"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "a0e3672b-7223-4cd3-82f4-a7b0bfaff5cb",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "handoffType": "H4",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-8",
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
  "createdAt": "2026-04-27T11:17:12.189Z",
  "createdBy": "e2e-fd-8",
  "stageContext": "S7"
}
```

- **Achieved**: YES

### S7->S8 progress-stage
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage",
  "body": {
    "targetStage": "S8",
    "version": 7
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
  "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "createdAt": "2026-04-27T11:17:01.496Z",
  "updatedAt": "2026-04-27T11:17:12.207Z",
  "createdBy": "e2e-fd-8",
  "version": 8,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:17:12.124Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-8",
  "registrationCompletedAt": "2026-04-27T11:17:12.124Z",
  "registrationCompletedBy": "e2e-fd-8"
}
```

- **Achieved**: YES

### S8 key return
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/key-return` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/key-return",
  "body": {
    "keyCountReturned": 2
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "944af8f2-6ad9-4420-890b-da9ea266ad72",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36",
  "receivedBy": "e2e-fd-8",
  "returnedAt": "2026-04-27T11:17:12.221Z",
  "keyCountIssued": 2,
  "keyCountReturned": 2,
  "countReconciled": true,
  "reconciliationNote": null,
  "createdAt": "2026-04-27T11:17:12.222Z"
}
```

- **Achieved**: YES

### S8 inspection
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/room-inspection` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/room-inspection",
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
  "id": "93c43298-d195-4fcc-b340-3cd01460ff1c",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "roomId": "9a1c90ef-3105-4291-8df0-a1fecab3ab36",
  "segmentId": "63732e15-1662-4ad7-b9e7-37c98d08453b",
  "inspectedBy": "e2e-fd-8",
  "inspectedAt": "2026-04-27T11:17:12.230Z",
  "isDeferred": false,
  "deficientFlagStatus": "NOT_APPLICABLE",
  "deficientConditionId": null,
  "inspectorAssessment": null,
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-04-27T11:17:12.231Z"
}
```

- **Achieved**: YES

### S8 fulfil H4
- **Goal**: Execute `POST` `/handoffs/a0e3672b-7223-4cd3-82f4-a7b0bfaff5cb/fulfil` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/handoffs/a0e3672b-7223-4cd3-82f4-a7b0bfaff5cb/fulfil",
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
  "id": "a0e3672b-7223-4cd3-82f4-a7b0bfaff5cb",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "handoffType": "H4",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-8",
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
  "fulfilledAt": "2026-04-27T11:17:12.236Z",
  "fulfilledBy": "e2e-fd-8",
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
  "createdAt": "2026-04-27T11:17:12.189Z",
  "createdBy": "e2e-fd-8",
  "stageContext": "S7"
}
```

- **Achieved**: YES

### S8 settle DIRECT_BILL (OUTSTANDING)
- **Goal**: Execute `POST` `/folios/0cc4599e-394f-4c13-b309-b80de96122c8/settle` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/folios/0cc4599e-394f-4c13-b309-b80de96122c8/settle",
  "body": {
    "settlementMethod": "DIRECT_BILL",
    "billingModelConfirmation": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "0cc4599e-394f-4c13-b309-b80de96122c8",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "state": "OUTSTANDING",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T11:17:01.615Z",
  "createdBy": "e2e-fd-8",
  "convertedToLiveAt": "2026-04-27T11:17:12.133Z",
  "convertedBy": "e2e-fd-8",
  "closedAt": "2026-04-27T11:17:12.247Z",
  "closedBy": "e2e-fd-8",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "500",
  "advancePaymentReconciliationComplete": true
}
```

- **Achieved**: YES

### S8->S9 progress-stage
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/progress-stage",
  "body": {
    "targetStage": "S9",
    "version": 8
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
  "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
  "createdAt": "2026-04-27T11:17:01.496Z",
  "updatedAt": "2026-04-27T11:17:12.277Z",
  "createdBy": "e2e-fd-8",
  "version": 9,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-27T11:17:12.124Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-8",
  "registrationCompletedAt": "2026-04-27T11:17:12.124Z",
  "registrationCompletedBy": "e2e-fd-8"
}
```

- **Achieved**: YES

### S9 fulfil H5
- **Goal**: Execute `POST` `/handoffs/5cee1237-3784-4b8a-96df-708a05b6fb01/fulfil` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/handoffs/5cee1237-3784-4b8a-96df-708a05b6fb01/fulfil",
  "body": {
    "fulfilmentEvidence": {
      "resolutionBasis": "WRITE_OFF"
    }
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "5cee1237-3784-4b8a-96df-708a05b6fb01",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "handoffType": "H5",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "e2e-fd-8",
  "toRole": "FINANCE",
  "toActorId": null,
  "checklistContent": {
    "basis": "Checkout governed outstanding",
    "outstandingBalance": "500"
  },
  "deficientConditionStatus": null,
  "fulfilmentEvidence": {
    "resolutionBasis": "WRITE_OFF"
  },
  "assignedAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "fulfilledAt": "2026-04-27T11:17:12.287Z",
  "fulfilledBy": "e2e-fd-8",
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
  "createdAt": "2026-04-27T11:17:12.277Z",
  "createdBy": "e2e-fd-8",
  "stageContext": "S8"
}
```

- **Achieved**: YES

### S9 write-off
- **Goal**: Execute `POST` `/folios/0cc4599e-394f-4c13-b309-b80de96122c8/write-off` and advance scenario state.
- **Request**: actor `L3`/`e2e-gm-8`

```json
{
  "method": "POST",
  "path": "/folios/0cc4599e-394f-4c13-b309-b80de96122c8/write-off",
  "body": {
    "amount": 10,
    "reason": "Small remainder write-off"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "865b6883-6e3f-4e73-89fd-bf1521d7bcaa",
  "folioId": "0cc4599e-394f-4c13-b309-b80de96122c8",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "writtenOffAmount": "10",
  "currency": "BTN",
  "reason": "Small remainder write-off",
  "createdAt": "2026-04-27T11:17:12.294Z",
  "createdBy": "e2e-gm-8"
}
```

- **Achieved**: YES

### S9 list invoices
- **Goal**: Execute `GET` `/folios/0cc4599e-394f-4c13-b309-b80de96122c8/invoices` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "GET",
  "path": "/folios/0cc4599e-394f-4c13-b309-b80de96122c8/invoices",
  "body": [
    {
      "id": "45845946-a0ed-4405-9ccf-5f1ea5127afb",
      "folioId": "0cc4599e-394f-4c13-b309-b80de96122c8",
      "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
      "invoiceType": "FINAL",
      "state": "DISPATCHED",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "final-v1",
      "issuedAt": "2026-04-27T11:17:12.245Z",
      "issuedBy": "e2e-fd-8",
      "dispatchedAt": "2026-04-27T11:17:12.245Z",
      "dispatchedBy": "e2e-fd-8",
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "billingModel": "GUEST_PAY",
        "settlementMethod": "DIRECT_BILL",
        "outstandingBalance": "500"
      },
      "createdAt": "2026-04-27T11:17:12.246Z"
    },
    {
      "id": "5baa054f-eefe-4ce6-9ecf-180612ea8260",
      "folioId": "0cc4599e-394f-4c13-b309-b80de96122c8",
      "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T11:17:01.616Z",
      "issuedBy": "e2e-fd-8",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T11:17:01.617Z"
    }
  ]
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S9 dispatch invoice 5baa054f-eefe-4ce6-9ecf-180612ea8260
- **Goal**: Execute `POST` `/invoices/5baa054f-eefe-4ce6-9ecf-180612ea8260/dispatch` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-8`

```json
{
  "method": "POST",
  "path": "/invoices/5baa054f-eefe-4ce6-9ecf-180612ea8260/dispatch",
  "body": {
    "dispatchedTo": "billing@example.com"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "5baa054f-eefe-4ce6-9ecf-180612ea8260",
  "folioId": "0cc4599e-394f-4c13-b309-b80de96122c8",
  "entryId": "69464aa7-77a8-43c8-a5a9-43045be29b95",
  "invoiceType": "PROFORMA",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": "proforma-v1",
  "issuedAt": "2026-04-27T11:17:01.616Z",
  "issuedBy": "e2e-fd-8",
  "dispatchedAt": "2026-04-27T11:17:12.301Z",
  "dispatchedBy": "e2e-fd-8",
  "dispatchedTo": "billing@example.com",
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "basis": "S3 setup",
    "dispatchedAt": "2026-04-27T11:17:12.301Z",
    "dispatchedBy": "e2e-fd-8"
  },
  "createdAt": "2026-04-27T11:17:01.617Z"
}
```

- **Achieved**: YES

### S9 close entry
- **Goal**: Execute `POST` `/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/close` and advance scenario state.
- **Request**: actor `L2`/`e2e-fom-8`

```json
{
  "method": "POST",
  "path": "/entries/69464aa7-77a8-43c8-a5a9-43045be29b95/close",
  "body": {
    "id": "69464aa7-77a8-43c8-a5a9-43045be29b95",
    "inquiryId": "9e7f7f73-4369-402d-a07e-044c452087ce",
    "guestProfileId": "9b33e663-9a0a-4d0f-a7e1-85c0235453d5",
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
    "createdAt": "2026-04-27T11:17:01.496Z",
    "updatedAt": "2026-04-27T11:17:12.319Z",
    "createdBy": "e2e-fd-8",
    "version": 10,
    "closedAt": "2026-04-27T11:17:12.318Z",
    "closedBy": "e2e-fom-8",
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": "2026-04-27T11:17:12.124Z",
    "keysIssuedCount": 2,
    "keysIssuedBy": "e2e-fd-8",
    "registrationCompletedAt": "2026-04-27T11:17:12.124Z",
    "registrationCompletedBy": "e2e-fd-8"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

